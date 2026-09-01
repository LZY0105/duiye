package com.latexsnipper.app.ocr;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Multi-request isolation, one-shot polling, cancel and TTL purge. */
public class AsyncOperationRegistryTest {

    @Test
    public void concurrentRequestsDoNotOverwriteEachOther() {
        AsyncOperationRegistry registry = new AsyncOperationRegistry();
        String a = registry.create("question");
        String b = registry.create("question");
        assertNotEquals(a, b);

        // Complete out of order.
        registry.complete(b, "{\"n\":2}", null);
        registry.complete(a, "{\"n\":1}", null);

        assertEquals("{\"n\":1}", registry.poll(a));
        assertEquals("{\"n\":2}", registry.poll(b));
    }

    @Test
    public void ocrAndQuestionOperationsStayIsolated() {
        AsyncOperationRegistry registry = new AsyncOperationRegistry();
        String ocr = registry.create("formula");
        String question = registry.create("question");

        registry.complete(question, "{\"status\":\"ok\"}", null);
        assertNull(registry.poll(ocr));           // reading one id never steals another's result
        assertEquals("{\"status\":\"ok\"}", registry.poll(question));
    }

    @Test
    public void pollBeforeCompletionReturnsNullAndLaterSucceeds() {
        AsyncOperationRegistry registry = new AsyncOperationRegistry();
        String id = registry.create("ocr");
        assertTrue(registry.isPending(id));
        assertNull(registry.poll(id));
        registry.complete(id, "payload", null);
        assertFalse(registry.isPending(id));
        assertEquals("payload", registry.poll(id));
    }

    @Test
    public void repeatedPollOfSameIdYieldsSecondReadNull() {
        AsyncOperationRegistry registry = new AsyncOperationRegistry();
        String id = registry.create("question");
        registry.complete(id, "r1", null);
        assertEquals("r1", registry.poll(id));
        assertNull(registry.poll(id)); // one-shot take
    }

    @Test
    public void doubleCompleteKeepsFirstResult() {
        AsyncOperationRegistry registry = new AsyncOperationRegistry();
        String id = registry.create("question");
        registry.complete(id, "first", null);
        registry.complete(id, "second", null);
        assertEquals("first", registry.poll(id));
    }

    @Test
    public void unknownAndCancelledIdsBehave() {
        AsyncOperationRegistry registry = new AsyncOperationRegistry();
        assertNull(registry.poll("nope"));
        assertFalse(registry.cancel("nope"));

        String id = registry.create("question");
        assertTrue(registry.cancel(id));
        registry.complete(id, "late result", null); // late completion is dropped
        assertNull(registry.poll(id));
    }

    @Test
    public void failurePayloadCarriesErrorCode() {
        AsyncOperationRegistry registry = new AsyncOperationRegistry();
        String id = registry.create("question");
        registry.complete(id, "{\"status\":\"error\"}", "QUESTION_PROMPT_TOO_LONG");
        assertEquals("{\"status\":\"error\"}", registry.poll(id));
    }

    /**
     * "" means "still pending" in the poll protocol, so a completion must never
     * store an empty payload — otherwise a finished operation is consumed and
     * removed while the web layer still reads it as running, and then polls a
     * now-unknown id for its full timeout.
     */
    @Test
    public void emptyCompletionIsNeverIndistinguishableFromPending() {
        AsyncOperationRegistry registry = new AsyncOperationRegistry();

        String nullResult = registry.create("ocr-formula");
        registry.complete(nullResult, null, null);
        assertFalse("pending after completing with null", registry.isPending(nullResult));
        assertEquals(AsyncOperationRegistry.EMPTY_RESULT, registry.poll(nullResult));

        String emptyResult = registry.create("ocr-formula");
        registry.complete(emptyResult, "", null);
        assertFalse("pending after completing with \"\"", registry.isPending(emptyResult));
        String polled = registry.poll(emptyResult);
        assertNotEquals("", polled);
        assertEquals(AsyncOperationRegistry.EMPTY_RESULT, polled);
    }

    /**
     * Every stored payload the web layer can poll must survive JSON.parse there.
     * Asserted structurally rather than with org.json, which Android stubs out
     * in unit tests (calling it throws "not mocked").
     */
    @Test
    public void tombstonePayloadsAreValidJsonObjectsCarryingAnError() {
        for (String payload : new String[]{
            AsyncOperationRegistry.EMPTY_RESULT,
            AsyncOperationRegistry.TIMEOUT_RESULT,
            AsyncOperationRegistry.CANCELLED_RESULT,
        }) {
            assertFalse("payload must not be empty", payload.isEmpty());
            assertTrue("payload must be a JSON object: " + payload,
                payload.startsWith("{") && payload.endsWith("}"));
            assertTrue("payload must carry an error code: " + payload,
                payload.contains("\"error\":\""));
            // A bare token such as "TIMEOUT" would throw in JSON.parse on the JS side.
            assertNotEquals("TIMEOUT", payload);
        }
    }

    /**
     * A pending task gets a longer budget than a finished result, so a task that
     * is still legitimately running is not expired at the same instant a
     * collected result is dropped.
     */
    @Test
    public void pendingTimeoutIsLongerThanResultTtlAndTombstonesNotCounted() {
        AsyncOperationRegistry registry = new AsyncOperationRegistry(1_000L, 5_000L);
        String pending = registry.create("question");
        long t0 = System.currentTimeMillis();

        assertEquals(0, registry.purgeExpired(t0 + 2_000L)); // past result TTL, still pending
        assertTrue(registry.isPending(pending));

        // Past the pending budget: tombstoned, but that is a state transition,
        // not a removal, so it must not be counted as removed.
        assertEquals(0, registry.purgeExpired(t0 + 6_000L));
        assertFalse(registry.isPending(pending));
        assertEquals(1, registry.size());

        // The tombstone is now a finished result and is reclaimed one TTL later.
        assertEquals(1, registry.purgeExpired(t0 + 8_000L));
        assertEquals(0, registry.size());
    }

    @Test
    public void expiredResultsArePurgedPendingOnesAreNot() {
        AsyncOperationRegistry registry = new AsyncOperationRegistry(5_000L);
        String done = registry.create("question");
        String pending = registry.create("question");
        registry.complete(done, "old", null);

        long finishedAt = System.currentTimeMillis();
        assertEquals(0, registry.purgeExpired(finishedAt + 4_999L)); // not yet expired
        assertEquals(1, registry.purgeExpired(finishedAt + 5_001L)); // expired → removed
        assertEquals(1, registry.size());                            // pending survives
        assertTrue(registry.isPending(pending));
    }
}
