# Gambit Gus compatibility patches

This directory contains the source of `github.com/notnil/chess` v1.10.0 under
its original MIT license. The root module uses it through a local `replace` so
the existing Go 1.20-compatible API remains stable.

Local changes:

- `Position.samePosition` compares the board value directly instead of
  constructing and comparing FEN strings.
- `Game.numOfRepetitions` traverses the package-owned position slice directly
  instead of allocating a defensive copy.
- `Position.UpdateInto` lets bounded search use caller-owned storage, while the
  compatible `Position.Update` keeps Position and Board in one heap object.
- `Board.PieceCount` exposes allocation-free population counts from the native
  bitboards for material evaluation.

These changes preserve position equality and repetition semantics. Keep this
file when syncing future upstream or successor-library changes so the patches
remain explicit and reviewable.
