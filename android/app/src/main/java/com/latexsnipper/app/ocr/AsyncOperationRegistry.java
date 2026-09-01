package com.latexsnipper.app.ocr;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Deep module holding results of async native operations keyed by request id
 * (rectification P1-01). Replaces the two volatile single-slot fields that let
 * concurrent requests overwrite each other's results.
 *
 * Behavior:
 * - create(type): thread-safe unique request id.
 * - complete(id, result): store success or failure payload exactly once per id;
 *   late completion of an unknown/cancelled id is ignored.
 * - poll(id): one-shot take; returns {@code null} while pending or unknown.
 * - cancel(id): removes a pending entry so a late completion is dropped.
 * - purgeExpired(nowMs): removes finished entries older than the result TTL, and
 *   tombstones pending entries older than the (longer) pending timeout.
 * - clear(): cancels everything (used when the app releases the bridge).
 */
final class AsyncOperationRegistry {

    /** Finished entries are kept this long for late polls, then purged. */
    static final long DEFAULT_TTL_MS = 10 * 60 * 1000L;

    /**
     * A pending operation gets a longer budget than a finished result: the result
     * TTL answers "how long do we hold an answer nobody collected", whereas the
     * pending budget answers "how long may native work legitimately run". Sharing
     * one value made a still-running task expire at the same instant as a
     * collected result (rectification P0-04).
     */
    static final long PENDING_TIMEOUT_MULTIPLIER = 4L;

    static final class Operation {
        final String id;
        final String type;
        final long createdAtMs = System.currentTimeMillis();
        volatile long completedAtMs = 0L;
        volatile String errorCode = null;   // null on success
        volatile String result = null;      // JSON payload once completed

        Operation(String id, String type) {
            this.id = id;
            this.type = type;
        }
    }

    private final Map<String, Operation> operations = new ConcurrentHashMap<>();
    private final long ttlMs;
    private final long pendingTimeoutMs;

    AsyncOperationRegistry() {
        this(DEFAULT_TTL_MS);
    }

    AsyncOperationRegistry(long ttlMs) {
        this(ttlMs, ttlMs * PENDING_TIMEOUT_MULTIPLIER);
    }

    AsyncOperationRegistry(long ttlMs, long pendingTimeoutMs) {
        this.ttlMs = ttlMs;
        this.pendingTimeoutMs = pendingTimeoutMs;
    }

    /** Creates a unique request id such as {@code question_42}. */
    String create(String type) {
        String id = (type == null ? "op" : type) + "_" + UUID.randomUUID();
        operations.put(id, new Operation(id, type));
        return id;
    }

    /**
     * Stores the result payload for an id. Unknown or cancelled ids are ignored,
     * and completing twice keeps the first result.
     */
    void complete(String id, String resultPayload, String errorCode) {
        if (id == null) return;
        Operation op = operations.get(id);
        if (op == null || op.result != null) return;
        synchronized (op) {
            if (op.result != null) return;
            // A completion must never be empty. The poll protocol uses "" to mean
            // "still pending", so storing an empty payload made a FINISHED
            // operation indistinguishable from a running one: the first poll
            // consumed and removed the entry, JS read "" as pending, and then
            // span its full 60-180s timeout against an id that no longer existed.
            op.result = (resultPayload == null || resultPayload.isEmpty())
                ? EMPTY_RESULT
                : resultPayload;
            op.errorCode = errorCode;
            op.completedAtMs = System.currentTimeMillis();
        }
    }

    /** Payload stored when a task completes without producing any output. */
    static final String EMPTY_RESULT = "{\"error\":\"EMPTY_RESULT\"}";

    /** Tombstone payload written when a pending operation is cancelled. */
    static final String CANCELLED_RESULT = "{\"error\":\"CANCELLED\"}";

    /**
     * One-shot take of a COMPLETED result. Polling a pending (or unknown) id
     * returns {@code null} and leaves the operation in the map untouched, so
     * background completion can never be lost to an early poll.
     */
    String poll(String id) {
        if (id == null) return null;
        Operation op = operations.get(id);
        if (op == null) return null;
        synchronized (op) {
            if (op.result == null) return null; // still pending — keep the entry
            return operations.remove(id) != null ? op.result : null;
        }
    }

    /** True when the id exists and has not completed yet. */
    boolean isPending(String id) {
        Operation op = id == null ? null : operations.get(id);
        return op != null && op.result == null;
    }

    /** Removes a pending operation; returns false when it was unknown or already done. */
    boolean cancel(String id) {
        if (id == null) return false;
        Operation op = operations.get(id);
        if (op == null) return false;
        synchronized (op) {
            if (op.result != null) return false;
            op.completedAtMs = System.currentTimeMillis();
            op.errorCode = "CANCELLED";
            // Tombstone so late completions are ignored. Non-empty like every
            // other stored result, keeping the "a set result is never empty"
            // invariant that the poll protocol relies on.
            op.result = CANCELLED_RESULT;
        }
        operations.remove(id);
        return true;
    }

    /**
     * Expires stale entries.
     *
     * <p>The return value counts <em>entries removed from the registry</em>, and
     * nothing else. Previously it also counted pending→TIMEOUT transitions, so a
     * caller could be told two entries were reclaimed while the map still held
     * both — the count, the lifecycle and the test disagreed (rectification
     * P0-04). The two lifecycles are now distinct:
     *
     * <ul>
     *   <li>A finished entry is removed once it is older than the result TTL.
     *       That is a removal and is counted.</li>
     *   <li>A pending entry older than the pending timeout becomes a TIMEOUT
     *       tombstone so a late completion can never overwrite it. That is a
     *       state transition, not a removal, so it is not counted — the entry is
     *       still there and still occupies a slot.</li>
     *   <li>The tombstone is itself a finished entry, so the next sweep one
     *       result TTL later removes it and counts it. No slot is held forever.</li>
     * </ul>
     */
    int purgeExpired(long nowMs) {
        int removed = 0;
        for (Map.Entry<String, Operation> e : operations.entrySet()) {
            Operation op = e.getValue();
            synchronized (op) {
                if (op.result != null) {
                    if (nowMs - op.completedAtMs > ttlMs && operations.remove(e.getKey(), op)) {
                        removed++;
                    }
                } else if (nowMs - op.createdAtMs > pendingTimeoutMs) {
                    op.completedAtMs = nowMs;
                    op.errorCode = "TIMEOUT";
                    op.result = TIMEOUT_RESULT;
                }
            }
        }
        return removed;
    }

    /**
     * Tombstone payload written when a pending operation exceeds its budget.
     * Must be valid JSON: the web layer JSON.parse()s whatever a poll returns,
     * and the previous bare "TIMEOUT" string threw a SyntaxError there instead
     * of surfacing as a timeout.
     */
    static final String TIMEOUT_RESULT = "{\"error\":\"TIMEOUT\"}";

    /** Cancels all pending operations and empties the registry. */
    void clear() {
        operations.clear();
    }

    int size() {
        return operations.size();
    }
}
