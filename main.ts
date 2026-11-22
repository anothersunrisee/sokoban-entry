// A Sokoban solver that works room by room.
//
// The generator builds every level as a one-square hallway with one to four
// small rooms off it, each room holding three or four boxes and as many goals.
// A box pushed out of a room's door into the hallway can never come back, so
// no box ever leaves its room and a level's push-optimal count is the sum of
// its rooms' optima. This solver leans on that: it cuts the level into rooms,
// solves each room push-optimally on its own with an A* over pushes, and
// stitches the rooms' move strings together with walks through the hallway.
//
// Inside a room the search is an A* over pushes. A state is the boxes' squares
// plus the player's reachable region (named by its lowest square); a push costs
// one. The estimate is the cheapest assignment of boxes to goals by walking
// distance over open floor, which never overestimates the pushes left (one push
// moves one box one square, so it lowers the assignment cost by at most one),
// so the first solution the search pops is push-optimal. Two deadlocks are
// pruned: a box on a square no pull can ever bring to a goal, and a box frozen
// inside a 2 x 2 block of walls and boxes. When the optimal search gives up on
// a room, a weighted search (same code, a heavier estimate) tries to find any
// solution at all, which still scores far more than leaving the room unsolved.
// The search is budgeted by work alone (a fixed number of expansions), never
// by the clock, so two runs answer alike.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets (deterministic; the wall clock is never read).
const EXPANSIONS_PER_ROOM = 250_000;
const EXPANSIONS_TOTAL = 2_000_000;

const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is a wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares a box can still be pushed onto some goal from, ignoring the
 * other boxes: pulled back from the goals, a square y is live when some live
 * square x sits one push beyond it (the player standing one square further
 * back, on open floor).
 */
function liveSquares(w: number, h: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    const xx = x % w;
    const xy = (x / w) | 0;
    for (const d of DIRS) {
      const nx = xx - d.dx;
      const ny = xy - d.dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const y = ny * w + nx;
      const bx = nx - d.dx;
      const by = ny - d.dy;
      if (bx < 0 || bx >= w || by < 0 || by >= h) continue;
      const back = by * w + bx;
      if (!wall[y] && !wall[back] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The squares the player reaches from `from` around walls and boxes, and the lowest of them. */
function floodRegion(
  w: number,
  h: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
): { low: number; seen: Uint8Array } {
  const seen = new Uint8Array(wall.length);
  const stack: number[] = [from];
  seen[from] = 1;
  let low = from;
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (p < low) low = p;
    const x = p % w;
    const y = (p / w) | 0;
    if (y > 0) {
      const q = p - w;
      if (!wall[q] && !occupied[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (y < h - 1) {
      const q = p + w;
      if (!wall[q] && !occupied[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (x > 0) {
      const q = p - 1;
      if (!wall[q] && !occupied[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (x < w - 1) {
      const q = p + 1;
      if (!wall[q] && !occupied[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return { low, seen };
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes with a box off its goal. */
function frozenBlockAt(w: number, wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The walking distance from every square to a goal, over open floor alone (walls only, boxes ignored). */
function distancesFrom(w: number, h: number, wall: Uint8Array, goal: number): Int32Array {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue: number[] = [goal];
  dist[goal] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    const x = p % w;
    const y = (p / w) | 0;
    const step = (q: number): void => {
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    };
    if (y > 0) step(p - w);
    if (y < h - 1) step(p + w);
    if (x > 0) step(p - 1);
    if (x < w - 1) step(p + 1);
  }
  return dist;
}

/**
 * The cheapest assignment of the boxes to the goals by walking distance:
 * the fewest pushes any completion needs at least. Infinity when some box
 * cannot walk to any goal. With at most four boxes this tries every pairing.
 */
function assignmentCost(boxes: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  const perm: number[] = [];
  for (let i = 0; i < n; i++) perm.push(i);
  const costOf = (p: number[]): number => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const d = dist[p[i]!]![boxes[i]!]!;
      if (d < 0) return Infinity;
      s += d;
    }
    return s;
  };
  let best = costOf(perm);
  // Heap's algorithm over the pairings, keeping the cheapest.
  const c: number[] = new Array(n).fill(0);
  let i = 0;
  while (i < n) {
    if (c[i]! < i) {
      if (i % 2 === 0) {
        const t = perm[0]!;
        perm[0] = perm[i]!;
        perm[i] = t;
      } else {
        const t = perm[c[i]!]!;
        perm[c[i]!] = perm[i]!;
        perm[i] = t;
      }
      const v = costOf(perm);
      if (v < best) best = v;
      c[i]!++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
  return best;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(w: number, h: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    const x = p % w;
    const y = (p / w) | 0;
    const step = (q: number, letter: string): void => {
      if (!wall[q] && !occupied[q] && prev[q] === -1) {
        prev[q] = p;
        how[q] = letter;
        queue.push(q);
      }
    };
    if (y > 0) step(p - w, 'u');
    if (y < h - 1) step(p + w, 'd');
    if (x > 0) step(p - 1, 'l');
    if (x < w - 1) step(p + 1, 'r');
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

/**
 * One room (or one whole level) solved by A* over pushes. A state is the
 * boxes' squares and the player's reachable region, named by its lowest
 * square; a push costs one. `weight` scales the estimate: 1 is the true A*,
 * push-optimal; heavier weights trade optimality for speed. The search spends
 * at most `roomBudget` expansions from the shared `total` budget, and gives
 * up (null) when either runs out.
 */
function solvePushes(
  w: number,
  h: number,
  wall: Uint8Array,
  goals: number[],
  boxes0: number[],
  player0: number,
  weight: number,
  roomBudget: number,
  total: { remaining: number },
): SearchResult | null {
  const size = w * h;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(w, h, wall, goals);
  const dist = goals.map((g) => distancesFrom(w, h, wall, g));
  const solved = (bs: number[]): boolean => bs.every((b) => goalSet[b]);
  if (boxes0.some((b) => !live[b])) return null;
  if (solved(boxes0)) return { pushes: 0, moves: '' };

  const keyOf = (bs: number[], low: number): number => {
    let k = low;
    for (const b of bs) k = k * size + b;
    return k;
  };
  // The states, in the order found: their boxes, the player's square, the
  // pushes so far, and the push that made them from their parent.
  const stBoxes: number[][] = [boxes0.slice()];
  const stPlayer: number[] = [player0];
  const stG: number[] = [0];
  const stParent: number[] = [-1];
  const stFrom: number[] = [-1];
  const stDir: number[] = [-1];
  const stKey: number[] = [];
  const bestG = new Map<number, number>();
  const occ0 = new Uint8Array(size);
  for (const b of boxes0) occ0[b] = 1;
  const reg0 = floodRegion(w, h, wall, occ0, player0);
  stKey.push(keyOf(boxes0, reg0.low));
  bestG.set(stKey[0]!, 0);
  const h0 = assignmentCost(boxes0, dist);
  if (h0 === Infinity) return null;

  // The open list: a heap on [f, h, order, state], f = pushes + weight * estimate.
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      const t = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        const t = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };
  heapPush([weight * h0, h0, seq++, 0]);

  const occ = new Uint8Array(size);
  let expansions = 0;
  let goalIdx = -1;
  while (heap.length > 0) {
    const top = heapPop();
    const s = top[3];
    const g = stG[s]!;
    if (bestG.get(stKey[s]!) !== g) continue; // stale: a better path to this state was found
    if (expansions >= roomBudget || total.remaining <= 0) return null;
    expansions++;
    total.remaining--;
    const boxes = stBoxes[s]!;
    if (solved(boxes)) {
      goalIdx = s;
      break;
    }
    occ.fill(0);
    for (const b of boxes) occ[b] = 1;
    const region = floodRegion(w, h, wall, occ, stPlayer[s]!);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di]!;
        const dd = d.dy * w + d.dx;
        const t = b + dd;
        const ps = b - dd;
        if (!region.seen[ps]) continue; // the player cannot stand behind this box
        if (wall[t] || occ[t]) continue; // the destination is blocked
        if (!live[t]) continue; // a box there could never reach a goal
        const nb = boxes.slice();
        nb[bi] = t;
        nb.sort((x, y) => x - y);
        occ[b] = 0;
        occ[t] = 1;
        const frozen = frozenBlockAt(w, wall, occ, goalSet, t);
        let key = -1;
        let hh = Infinity;
        let low = -1;
        if (!frozen) {
          const nreg = floodRegion(w, h, wall, occ, b);
          low = nreg.low;
          key = keyOf(nb, low);
          const prevBest = bestG.get(key);
          if (prevBest === undefined || prevBest > g + 1) hh = assignmentCost(nb, dist);
        }
        occ[t] = 0;
        occ[b] = 1;
        if (frozen || hh === Infinity) continue;
        if (bestG.get(key) !== undefined && bestG.get(key)! <= g + 1) continue;
        bestG.set(key, g + 1);
        const idx = stBoxes.length;
        stBoxes.push(nb);
        stPlayer.push(b);
        stG.push(g + 1);
        stParent.push(s);
        stFrom.push(b);
        stDir.push(di);
        stKey.push(key);
        heapPush([g + 1 + weight * hh, hh, seq++, idx]);
      }
    }
  }
  if (goalIdx < 0) return null;
  // The path of pushes, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = goalIdx; s > 0; s = stParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = player0;
  let boxes = boxes0.slice();
  for (const s of path) {
    const from = stFrom[s]!;
    const di = stDir[s]!;
    const d = DIRS[di]!;
    const dd = d.dy * w + d.dx;
    const to = from + dd;
    occ.fill(0);
    for (const b of boxes) occ[b] = 1;
    moves += walkTo(w, h, wall, occ, player, from - dd);
    moves += d.push;
    player = from;
    const at = boxes.indexOf(from);
    boxes[at] = to;
    boxes.sort((a, b) => a - b);
  }
  return { pushes: path.length, moves };
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that holds
 * a box is a room, its squares, boxes and goals. Null when some part holds
 * more or fewer boxes than goals, or a box or goal sits in the cut hallway.
 */
function roomsOf(lv: Level): Room[] | null {
  const { w, h, wall, goals, boxes, player } = lv;
  const live = liveSquares(w, h, wall, goals);
  const row = (player / w) | 0;
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      const x = p % w;
      const y = (p / w) | 0;
      const next: number[] = [];
      if (y > 0) next.push(p - w);
      if (y < h - 1) next.push(p + w);
      if (x > 0) next.push(p - 1);
      if (x < w - 1) next.push(p + 1);
      for (const q of next) {
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    const r = part[b];
    if (r < 0) return null;
    rooms[r]!.boxes.push(b);
  }
  for (const g of goals) {
    const r = part[g];
    if (r < 0) return null;
    rooms[r]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The moves that solve a level, room by room; an empty string when it gives up. */
function solve(text: string, total: { remaining: number }): string {
  const lv = parseLevel(text);
  if (lv.boxes.every((b) => lv.goals.includes(b))) return '';
  const rooms = roomsOf(lv);
  if (rooms === null) return '';
  let player = lv.player;
  let moves = '';
  for (const room of rooms) {
    // The room's own board: the level's walls, with the other rooms' boxes
    // standing as walls (on their goals once their room is done).
    const wall = lv.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const blocks = other.done ? other.goals : other.boxes;
      for (const b of blocks) wall[b] = 1;
    }
    const goals = room.goals.slice().sort((a, b) => a - b);
    const boxes = room.boxes.slice().sort((a, b) => a - b);
    let found = solvePushes(lv.w, lv.h, wall, goals, boxes, player, 1, EXPANSIONS_PER_ROOM, total);
    if (found === null) found = solvePushes(lv.w, lv.h, wall, goals, boxes, player, 2.5, EXPANSIONS_PER_ROOM, total);
    if (found === null) return '';
    moves += found.moves;
    player = endOf(lv.w, player, found.moves);
    room.done = true;
  }
  return moves;
}

const total = { remaining: EXPANSIONS_TOTAL };
for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'), total);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
