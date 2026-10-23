# Notes for Claude

## Version number — update it with every change that gets merged

The version shown at the bottom of the settings panel is the sum of the
`?v=` tags on the three app files in `index.html`:

```html
<link rel="stylesheet" href="style.css?v=…">
<script src="script.js?v=…"></script>
<script src="features.js?v=…"></script>
```

Every time a change is merged (or pushed to `main`), bump the `?v=` tag of
each file that changed by 1, in the same commit as the change. This both
busts the browser cache and makes the version number go up, so the user can
tell whether a device has the latest update. Never merge a change to
`style.css`, `script.js` or `features.js` without bumping its tag.

After a push, tell the owner only the version number settings shows (the
sum: "version 1,166") — never the separate `?v=` tags or a commit hash.

## Always push to `main`

When a change is done, commit it and push it straight to `main` (after
bumping the version tags above) — that's what deploys the app (Vercel).
Don't leave work only on a side branch or ask first.

## One look with the financial dashboard — always

The owner wants this app and the financial dashboard
(`shihcb/financial-dashboard`, `public/index.html`) to feel like one app.
The dashboard's look is the source: **whenever the dashboard's style changes,
this app's changes to match, in the same piece of work** — colours and
tokens, type sizes and weights, corners, borders and hairlines, shadows,
spacing, buttons, pills and badges, tab switchers, menus, windows, icons,
motion, wording style. Never leave one updated and the other behind.

- Working in the dashboard and changing how it looks: make the same change
  here too (bump the `?v=` tags, push to `main`), and the other way round —
  a look the owner asks for here goes into the dashboard as well.
- Before any style work here, look at the dashboard's current CSS
  (`public/index.html`) and match it — measure both (sizes, colours,
  computed styles, screenshots side by side), don't guess.
- Where the owner has asked this app to look different from the dashboard,
  it stays different until they say otherwise — but say so when it comes up,
  and ask whether the dashboard should take it too. Today: fields, search
  boxes, buttons, username rows and count pills are white in light mode
  (the dashboard's are the page grey). Nothing else differs.
- These notes are kept in step with the dashboard's own CLAUDE.md.

## "The list 3 slide" — the app's standard motion

When the user says **"the list 3 slide"** (or "the app's animation", "same
timing as everything else"), they mean the motion list 3's rows use:
**450ms, `cubic-bezier(0.4, 0, 0.2, 1)`** — `ROW_MOTION_MS` and `rowEase`
in `script.js` (in CSS: `0.45s cubic-bezier(0.4, 0, 0.2, 1)`). That's also
exactly the instructions modal's open/close timing: every animation in the
app (entering, leaving, resizing, sliding, tab switches, counters, charts)
uses it unless told otherwise — hover/press/focus color changes too. Only
loading spinners and looping decorations are exempt. Shapes are shared
too: pop-ups (and the log-in card, account chips) come in from 14px down at
95% scale and leave the same way back; the bottom bars (toast, select) from
16px at 96%; the app itself (after logging in / out) from 16px at 97%;
nothing is staggered, and what replaces something crosses it (never out,
then in); presses and hovers only change colour; switching light / dark
eases every colour (theme-fade); spinners turn every 0.8s; usernames and banners use list 3's row engine
(slideRowIn/slideRowOut, rows around them shifting); a search's results are the dashboard's search: a moment after typing stops, matches that stay glide to their places, new ones pop in from 14px down at 95%, hidden ones pop out the same way, all on that same engine (popRowIn/popRowOut — a row coming back mid-pop carries on from where it's drawn), "no matches" fading in under the last ones; tab switches are the
sideways push (slideSub / TAB_MOTION), the area easing to the new pane's
height (easeBoxHeight); texts just fade (fadeEmptyIn), and text that changes
fades across — the old words out where they were, the new in (swapText;
`{ resize: true }` for buttons and pills, so their width eases too). When the
page gets shorter it glides up on the curve (setupPageGlide). A button waiting on
something (log in, a saved import coming down) keeps its words, dimmed a
little, and glides wider as a spinner swoops in after them, then back once
done (workButton) — never "syncing"; done with a check, the spinner swoops
away first and the check comes into its room (workDone). Google drive's
"sync now" is the dashboard's sync button: its fill grows and its words say
the stage it's at ("finding exports", "importing 1 of 2", "saving imports"),
crossing over (swapText), then what it did ("2 exports imported"). A username too long
for its row glides sideways to show the rest and back, on a loop, its
passing edge fading (the dashboard's marquee: .glides, measureGlide) —
never wrapped, never "…". With the
phone's Reduce Motion on, everything goes straight to where it's headed
(spinners keep turning). These come from the financial dashboard.

## No circles

Nothing is round: icon buttons, avatars, pills, badges, chips, the switch —
every one a squircle on the small buttons' and search box's 8px corners
(the dashboard's `--r-sm`; the dashboard is the same). Only spinners and the
timeline's points stay round.

## Labels and buttons only (the financial dashboard's conventions)

No helper or caption text under features — labels and buttons only (a
status line that changes, like "last synced …", is fine; with nothing to
say it takes no room). Text sizes are only the `--fs-*` steps (sm 11.5,
md 13, base 15, lg 17, xl 20; only the big display figures above them),
weights 400 / 500 titles / 600 labels and buttons. Small buttons are one
size (24px, `.btn-sm`) — list 3's menu buttons (unfollowed, starred, import
files) too; a pick that's a form field (compare's account pickers) is the
dashboard's field drop-down (`.dd-btn`: the body's size, words left, chevron
right); arrow buttons are its 30px squares (the instructions' back / next —
back dimmed on the first step, next on the last). A window's ✕ only closes
it, in its top right corner on its title's line (the dashboard's
`.modal-x`) — no "close" buttons anywhere (the love note too). An account
badge is the dashboard's email badge (`.pill.mail-badge`): small, muted, the
page colour in a hairline; with its ↗ when a tap opens something (google
drive's opens the exports in drive; disconnecting is its own "remove",
asked first, as the dashboard removes a bank), without when it doesn't
(logged in as). Wording is lowercase, no full stops or "!",
failures as "… couldn’t be …", months in full ("october 20"), numbers with
thousands separators. Changing text fades across (swapText), counts count;
a finished action shows a check after its button's words (doneCheck), never
a pop-up saying it's done. The toast is the select bar's own bar.

## The app's name and icon

The app is called **Instagram by S** (written just so: page title, home
screen name, manifest, the iPhone app, the landing page and log-in card).
Its icon follows the financial dashboard's icon rules: a 1024px square of
one flat colour (a deep shade of the app's green, #047857 — iOS rounds the
corners itself), one white line glyph, stroke 2 on the 24-unit grid with
round ends, drawn 32x and centred — no gradient, shadow or text. The glyph
is "one-way": an arrow goes out to them, the one coming back stops short,
a dot where its arrowhead should be (`M3 10.25h16`, `m15.5 6.75 3.5 3.5-3.5
3.5`, `M21 17.25H11`, `M6.5 17.25h0`). `images/app-icon.png` (1024, also the iPhone
app's AppIcon) and `images/apple-touch-icon.png` (180); the landing logo
uses the same glyph.

## Text centred in buttons — the app's font

The app's font is the financial dashboard's Ledger Serif, `fonts/ledger-serif.woff2`
('Ledger Serif', in `--font-sans` / `--font-display`) — Source Serif 4 with
its letters drawn higher in their line (line heights and baselines
unchanged): 0.03em — the dashboard's file lowered .03em. The eye takes
in the whole word, tall letters (h, l, d, b, f, @) and all, so words read
high when only the small letters' middle is centred: at .11em, .085em and
the dashboard's own .06em the owner saw them high on the iPhone (the whole
word measured 1–2px high). Don't raise it again.
Buttons and boxes take an exact line height — 1.4 (the browser's `normal`
put this serif's extra gap all under the words), 22px for 15px words (21
rounds them ¾px low); count pills have a set height with the 1.4 line
inside; figures in the number squares sit as they are (no padding). To re-measure: screenshot each element and
compare its lowercase letters' middle with the box's. Never nudge a button's words with uneven padding or
`top: 1px`; if the font is ever changed, raise the new one the same way
(its glyphs, not its ascent/descent). OFL: `fonts/OFL.txt`. No other font
is loaded (no Google Fonts).

## Saved import files live in Supabase Storage

Import zips are uploaded to the Supabase Storage bucket **`imports`**, at
`<user id>/<account>/import-<n>.zip` (features.js, "saved imports"). Nothing
is kept on the device. The bucket and its per-user policies must exist in
the Supabase project (SQL editor):

```sql
insert into storage.buckets (id, name, public) values ('imports', 'imports', false);
create policy "imports: read own"   on storage.objects for select to authenticated using (bucket_id = 'imports' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "imports: add own"    on storage.objects for insert to authenticated with check (bucket_id = 'imports' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "imports: change own" on storage.objects for update to authenticated using (bucket_id = 'imports' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "imports: remove own" on storage.objects for delete to authenticated using (bucket_id = 'imports' and (storage.foldername(name))[1] = auth.uid()::text);
```
