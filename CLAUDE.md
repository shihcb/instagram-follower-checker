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

## Always push to `main`

When a change is done, commit it and push it straight to `main` (after
bumping the version tags above) — that's what deploys the app (Vercel).
Don't leave work only on a side branch or ask first.

## "The list 3 slide" — the app's standard motion

When the user says **"the list 3 slide"** (or "the app's animation", "same
timing as everything else"), they mean the motion list 3's rows use:
**450ms, `cubic-bezier(0.4, 0, 0.2, 1)`** — `ROW_MOTION_MS` and `rowEase`
in `script.js` (in CSS: `0.45s cubic-bezier(0.4, 0, 0.2, 1)`). That's also
exactly the instructions modal's open/close timing: every animation in the
app (entering, leaving, resizing, sliding, tab switches, counters, charts)
uses it unless told otherwise. Only hover/press color feedback, loading
spinners and looping decorations are exempt.

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
