// OCR —— 一张黑白字图抽成单线的笔画：先细化（Guo–Hall）成一像素宽的中心线，再沿线走一遍拆成一条条折线，最后抽稀。
//
// 「转为笔迹」要的是笔画，不是字的轮廓：笔迹在这个软件里是一串中心点加粗细（见 stroke.js），拿中心线来写，和人手写的
// 那几笔是同一种东西——能擦、能套、能换色、导出时照样是笔迹。纯数组运算，不碰画布，所以能在 Node 里单独测。
//
// 掩码：Uint8Array，宽 × 高，1 是墨。

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/**
 * Guo–Hall 细化（1989，两个子迭代的并行细化）：一圈一圈剥掉边上的像素，直到每一笔只剩一像素宽，连通不断。
 *
 * 原来用的是 Zhang–Suen。它有个出了名的毛病：两三像素粗的斜线会被整条剥光——KaTeX 的「×」画出来两条斜线一条五像素、
 * 一条四像素，细化完「/」那条没了，写成笔迹只剩一个「\」。Guo–Hall 按「删了会不会断」和「是不是线头」来判，斜线留得住，
 * 别的字形和原来差不多。
 * @returns {Uint8Array} 新的掩码（不改传进来的那一份）
 */
export function thin(mask, width, height) {
  const img = mask.slice();
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!img[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return img;
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : img[y * width + x]);
  const clear = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      clear.length = 0;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (!img[y * width + x]) continue;
          // p2 上、p3 右上、p4 右……顺时针到 p9 左上。
          const p2 = at(x, y - 1); const p3 = at(x + 1, y - 1); const p4 = at(x + 1, y); const p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1); const p7 = at(x - 1, y + 1); const p8 = at(x - 1, y); const p9 = at(x - 1, y - 1);
          // 删了它，周围的墨会不会断成两块：周围一圈只连成一片才能删。
          const c = (!p2 & (p3 | p4)) + (!p4 & (p5 | p6)) + (!p6 & (p7 | p8)) + (!p8 & (p9 | p2));
          if (c !== 1) continue;
          // 是不是线头、是不是已经细到底：两种数法取小的，在 2 和 3 之间才删。
          const n1 = (p9 | p2) + (p3 | p4) + (p5 | p6) + (p7 | p8);
          const n2 = (p2 | p3) + (p4 | p5) + (p6 | p7) + (p8 | p9);
          const n = Math.min(n1, n2);
          if (n < 2 || n > 3) continue;
          // 两个子迭代各剥一边（先东南、再西北），左右上下轮流来，中心线才不歪。
          const m = step === 0 ? ((p6 | p7 | !p9) & p8) : ((p2 | p3 | !p5) & p4);
          if (m !== 0) continue;
          clear.push(y * width + x);
        }
      }
      if (clear.length) {
        changed = true;
        for (const i of clear) img[i] = 0;
      }
    }
  }
  return img;
}

/**
 * 一像素宽的中心线拆成折线。
 *
 * 哪里断开看「交叉数」（绕一圈，从无墨到有墨跳了几次），不看邻居个数：细化完的斜线是台阶状的，拐角那一格邻居有三个，
 * 按邻居数会被当成岔路口，一条斜线碎成一地小段；交叉数在台阶上还是 2，它才是真正的「线中间」。1 是线头，3 以上是岔口。
 * 走的时候先走横竖的邻居、再走斜的，台阶上那一格不会被落下。
 *
 * @returns {Array<Array<[number, number]>>} 每条折线是一串像素坐标（像素中心）
 */
export function tracePaths(skel, width, height) {
  const on = (x, y) => x >= 0 && y >= 0 && x < width && y < height && skel[y * width + x] === 1;
  const crossing = (x, y) => {
    let n = 0;
    for (let k = 0; k < 8; k++) {
      const [ax, ay] = N8[k];
      const [bx, by] = N8[(k + 1) % 8];
      if (!on(x + ax, y + ay) && on(x + bx, y + by)) n++;
    }
    return n;
  };
  const degree = (x, y) => N8.reduce((n, [dx, dy]) => n + (on(x + dx, y + dy) ? 1 : 0), 0);
  const visited = new Uint8Array(width * height);
  const junction = new Uint8Array(width * height);
  const pixels = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!on(x, y)) continue;
      pixels.push([x, y]);
      if (crossing(x, y) >= 3) junction[y * width + x] = 1;
    }
  }
  // 横竖的邻居排在前面。
  const ORDER = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
  const paths = [];

  /**
   * 从一个普通像素（不是岔口）往前走：先走没走过的普通像素；走不下去了，旁边要是有岔口就停在岔口上（岔口可以是
   * 好几条线共用的端点，所以不记「走过」）。`from` 是刚离开的那个岔口——头两步不许走回去，不然原地打转。
   */
  const walk = (sx, sy, from = null) => {
    const path = [[sx, sy]];
    visited[sy * width + sx] = 1;
    let x = sx;
    let y = sy;
    for (;;) {
      let next = null;
      for (const [dx, dy] of ORDER) {
        const nx = x + dx;
        const ny = y + dy;
        const i = ny * width + nx;
        if (on(nx, ny) && !junction[i] && !visited[i]) { next = [nx, ny]; break; }
      }
      if (!next) {
        for (const [dx, dy] of ORDER) {
          const nx = x + dx;
          const ny = y + dy;
          if (!on(nx, ny) || !junction[ny * width + nx]) continue;
          if (from && nx === from[0] && ny === from[1] && path.length < 3) continue;
          path.push([nx, ny]);
          break;
        }
        return path;
      }
      path.push(next);
      visited[next[1] * width + next[0]] = 1;
      [x, y] = next;
    }
  };

  // 1. 从线头走起。
  for (const [x, y] of pixels) {
    const i = y * width + x;
    if (visited[i] || junction[i]) continue;
    if (degree(x, y) === 0) { visited[i] = 1; paths.push([[x, y]]); continue; }
    if (crossing(x, y) === 1) paths.push(walk(x, y));
  }
  // 2. 从岔口往每个还没走过的方向走。
  for (const [x, y] of pixels) {
    if (!junction[y * width + x]) continue;
    for (const [dx, dy] of ORDER) {
      const nx = x + dx;
      const ny = y + dy;
      if (!on(nx, ny) || visited[ny * width + nx] || junction[ny * width + nx]) continue;
      paths.push([[x, y], ...walk(nx, ny, [x, y])]);
    }
  }
  // 3. 剩下的是没有线头、没有岔口的圈（o、0 这种）：从哪儿起都行，走一圈再接回起点。
  for (const [x, y] of pixels) {
    const i = y * width + x;
    if (visited[i] || junction[i]) continue;
    const loop = walk(x, y);
    const [ex, ey] = loop[loop.length - 1];
    if (loop.length > 2 && Math.abs(ex - x) <= 1 && Math.abs(ey - y) <= 1) loop.push([x, y]);
    paths.push(loop);
  }

  // 细化在拐角留下的小毛刺：一头是线头、一头连在岔口上、不到 4 个像素长的，不要。
  return paths.filter((p) => {
    if (p.length >= 4 || p.length === 1) return true;
    const [hx, hy] = p[0];
    const [tx, ty] = p[p.length - 1];
    const touchesJunction = junction[hy * width + hx] || junction[ty * width + tx];
    return !touchesJunction;
  }).map((p) => p.map(([x, y]) => [x + 0.5, y + 0.5]));
}

/** 抽稀（Ramer–Douglas–Peucker）：离直线不到 epsilon 像素的点都可以去掉，头尾留着。 */
export function simplifyPath(points, epsilon = 0.9) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const d = len < 1e-9 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > epsilon && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** 量拐弯用的窗口：往前、往后各看几步（像素）。 */
const CORNER_WINDOW = 4;
/** 窗口里拐过多大的角才可能是尖角（弧度，约 50°）。 */
const CORNER_TURN = (50 * Math.PI) / 180;
/** 拐弯集中在一点（尖角）还是均匀地弯（弧线）：窗口放大一倍，拐的角度涨不到这么多倍的，算集中。 */
const CORNER_CONCENTRATION = 1.35;
/** 拆出来比这还短（像素）的小段不要：那是十字交叉处细化留下的一步斜岔，夹在两段中间，写出来就是一个墨点。 */
const MIN_PIECE = 2;

function turnAt(path, i, k) {
  const n = path.length;
  const a = path[Math.max(0, i - k)];
  const b = path[i];
  const c = path[Math.min(n - 1, i + k)];
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < 1e-9 || lv < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
}

const pathLength = (path) => {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return len;
};

/**
 * 在尖角处拆开（用的是细化以后、抽稀以前那一串逐像素的点）。
 *
 * 笔迹是沿相邻采样点中点的平滑曲线画的（ink-renderer.js 的 smoothSamples）：手写的采样很密，转角只圆掉一丁点；可拆出来的
 * 线一笔里拐直角，抽稀以后拐角只剩一个点，整个角会被抹成一大段圆弧——「+」在交叉处被拆成两条 L 形的线，一抹就成了错开
 * 的两个弯；在拐角两边补点也不行，书上那么小的时候补的那几小段会糊成一团。拆成几笔，每一笔都是直的或平滑的弯，多大都
 * 画得对（人说「有些符号识别对了，但是转化为笔记后却不正确了」）。
 *
 * 只拆尖角，不拆弧线：窗口里拐过 50° 以上，而且窗口放大一倍拐的角度涨不到 1.35 倍——拐弯集中在一点。弧线的弯是均匀的，
 * 窗口放大一倍拐的角也大约翻一倍。
 *
 * @param {Array<[number, number]>} path 逐像素的点
 * @returns {Array<Array<[number, number]>>}
 */
export function splitAtCorners(path) {
  const n = path.length;
  const k = CORNER_WINDOW;
  if (n < 2 * k + 1) return [path];
  const turns = path.map((_, i) => (i < 2 || i > n - 3 ? 0 : turnAt(path, i, k)));
  const cuts = [];
  for (let i = 2; i <= n - 3; i++) {
    const t = turns[i];
    if (t < CORNER_TURN) continue;
    // 一个尖角只拆一次：附近拐得最狠的那一点。
    let peak = true;
    for (let j = Math.max(2, i - k); j <= Math.min(n - 3, i + k); j++) {
      if (turns[j] > t || (turns[j] === t && j < i)) { peak = false; break; }
    }
    if (!peak) continue;
    if (turnAt(path, i, 2 * k) > t * CORNER_CONCENTRATION) continue;
    cuts.push(i);
  }
  if (!cuts.length) return [path];
  const pieces = [];
  let from = 0;
  for (const cut of cuts) {
    pieces.push(path.slice(from, cut + 1));
    from = cut;
  }
  pieces.push(path.slice(from));
  const kept = pieces.filter((piece) => pathLength(piece) >= MIN_PIECE);
  return kept.length ? kept : [path];
}

/**
 * 细化会把很小的一团整个剥光：2×2 的方块，四个像素在同一轮里都合「可以剥」的条件，一起没了——而那正是「·」、i 和 j
 * 上那一点、小数点、省略号的大小。原图里一个连通块拆完线一个像素都没留下，就在它的重心补一个点（一个点的笔迹画出来是
 * 一个圆点）。
 *
 * @param {Uint8Array} covered 拆出来的线经过了哪些像素
 * @returns {Array<Array<[number, number]>>} 每一个丢了的块一条只有一个点的「线」
 */
function lostDots(mask, covered, width, height) {
  const seen = new Uint8Array(width * height);
  const stack = [];
  const dots = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    let kept = false;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      const x = i % width;
      const y = (i - x) / width;
      sumX += x;
      sumY += y;
      count++;
      if (covered[i]) kept = true;
      for (const [dx, dy] of N8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (!kept) dots.push([[sumX / count + 0.5, sumY / count + 0.5]]);
  }
  return dots;
}

/** 一张掩码一步到位：细化 → 拆线 → 在尖角处拆开 → 抽稀；细化时整个剥光了的小点补回来。 */
export function maskToPaths(mask, width, height, { epsilon = 0.9 } = {}) {
  const traced = tracePaths(thin(mask, width, height), width, height);
  const covered = new Uint8Array(width * height);
  for (const path of traced) for (const [x, y] of path) covered[Math.floor(y) * width + Math.floor(x)] = 1;
  return traced.flatMap(splitAtCorners).map((p) => simplifyPath(p, epsilon)).concat(lostDots(mask, covered, width, height));
}
