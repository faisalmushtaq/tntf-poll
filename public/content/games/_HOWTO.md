# Match highlights — one file per game

Highlights on the History detail page are driven by the files in this folder.
No build step and no code: add a file, commit/push, and the site renders it.

## Add highlights to a game

1. Copy `_TEMPLATE.md` to a new file named after the game's date, in the form
   `YYYY-MM-DD.md`. For the game on 13 January 2026 that's:

       public/content/games/2026-01-13.md

   (The date must match the fixture — it's how the app finds the file. You can
   see each game's date on the History page.)

2. Fill in the lines you have. Everything is optional:

   - `video:`  a YouTube link. Highlights are usually in two parts, so add two
     `video:` lines and they show as "part 1" and "part 2".
   - `clip:`   a YouTube link to a short clip, with an optional `| caption`.
     Add as many `clip:` lines as you like.
   - `note:`   a line of match notes. Plain text or light markdown
     (`**bold**`, `*italic*`, `[links](https://example.com)`). Blank lines
     start a new paragraph.

3. Commit and push. That game's Highlights section updates automatically.

Games with no file here just show their line-ups and score — add a file
whenever you have highlights.

## YouTube links

Any of these shapes work:
`https://www.youtube.com/watch?v=ID`, `https://youtu.be/ID`,
`https://www.youtube.com/embed/ID`, `https://youtube.com/shorts/ID`.
Videos are embedded privately via youtube-nocookie.com.

Files whose names start with `_` (like this one and `_TEMPLATE.md`) are just
docs — they're never treated as a game.
