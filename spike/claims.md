# Claims: Tic-Tac-Toe session scoreboard

Page: `/games/tic-tac-toe/` (served by Vite). The scoreboard shows the result of each game in this browser tab. Scores are not saved after a page reload.

- C1: The page shows a scoreboard with three counters labeled "X wins", "O wins" and "Draws". All three show 0 when the page loads.
- C2: When X wins a game, the "X wins" counter shows 1. The other two counters still show 0.
- C3: When a game ends in a draw, the "Draws" counter shows 1.
- C4: After a game ends, the "Reset game" button clears the board and keeps the counters.
- C5: A "Reset scores" button sets all three counters to 0. It does not clear the board.
- C6: A finished game is counted once. Clicking a filled cell after the game ends does not change any counter.
