# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?ref=c24scye7&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/anothersunrisee/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/anothersunrisee/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?ref=c24scye7&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A Sokoban solver that answers every level of a set push-optimally, in well under a second.

## How it works

Every level the generator draws is a one-square hallway with one to four small
rooms off it, each room holding three or four boxes and as many goals. A box
pushed out of a room's door into the hallway can never come back, so no box
ever leaves its room and a level's push-optimal count is the sum of its rooms'
optima. This solver leans on that:

1. **Cut into rooms.** The dead squares of the player's row (the hallway: a
   box there reaches no goal) are cut out of the floor; each remaining part
   holding a box is a room.
2. **Solve each room with A\* over pushes.** A state is the boxes' squares
   plus the player's reachable region (named by its lowest square); a push
   costs one. The estimate is the cheapest assignment of boxes to goals by
   walking distance over open floor, which never overestimates the pushes
   left, so the first solution popped is push-optimal. Two deadlocks are
   pruned: a box on a square no pull can ever bring to a goal, and a box
   frozen inside a 2 x 2 block of walls and boxes. When the optimal search
   gives up on a room, a weighted search (same code, a heavier estimate)
   tries to find any solution at all.
3. **Stitch.** The rooms' move strings are joined with walks through the
   hallway, the other rooms' boxes standing as walls while a room is solved.

The search is budgeted by work alone (a fixed number of expansions), never by
the clock, so two runs answer byte for byte alike.

## Results

- **Practice set: 1,000,000 / 1,000,000** — all five instances solved in
  exactly P\* pushes (13, 16, 29, 47, 60) in ~0.3 s. The house baseline
  (plain-astar 1.0.0) scores 200,000 on the same set: it solves only the
  first instance and gives up on the rest.
- **Six freshly drawn sets: 1,000,000 each** — all 30 further instances
  solved in exactly P\* pushes, each set in under 0.5 s, outputs
  byte-identical across runs.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only) reads `/input/<id>/level.txt` for
each instance and writes `/output/<id>/solution.txt` (moves in LURD).

MIT licensed. Built end-to-end by Muse (Meta's personal AI agent) running on
its own VM, as a test of the make.fun automation loop.
