# Constellation

A simple habit tracker. Static site, no build step, no backend, no account.

- **Today** (one page): the sky is at the top and habits sit below it. Every habit has its own star colour and shape (change them anytime from the ⋯ on its card) and draws its own strand of stars. The sky starts at the left on your first day and fills rightward over 28 days, then a fresh sky begins; use the arrows to revisit older ones. Log a habit (Done or Not today, your mood, an optional note) and its star lights up right away. Brighter, bigger stars mean a happier mood.
- **Analytics**: streaks, 30-day completion, a 12-week heatmap, a 30-day mood trend, mood per habit and a plain-language insight about which habits lift your mood. Filter by one habit or see all.
- **Data**: always kept in the browser first, and with an optional account (below) also saved to the cloud so it survives cleared browsers, Safari's 7-day cleanup, and new devices. Export CSV, download or restore a JSON backup, or delete everything, all from the bottom of Analytics.

## Keep data permanently (Supabase, free)

Browsers can erase local storage (Safari after about 7 days without a visit, private windows, clear-on-exit settings). To keep data for good:

1. Create a free project at https://supabase.com.
2. SQL Editor, New query, paste the contents of `supabase.sql`, Run.
3. Project Settings, API: copy the **Project URL** and the **anon public** key into `js/config.js`.
4. Authentication, URL Configuration: set **Site URL** to your Vercel address (for example `https://constellation-taupe.vercel.app`) and add the same address under Redirect URLs.
5. Commit and push. Vercel redeploys.

Visitors then see "Keep your data safe": they enter an email, click the emailed link, and their habits sync automatically. The anon key is meant to be public; row level security in `supabase.sql` lets each person read and write only their own data. If `config.js` is left empty the app works exactly as before, browser-only.

Sync keeps the newest copy. If you use two devices at the same moment, the last device to save wins.

## Run locally

```
python3 -m http.server 8080
```

Open http://localhost:8080.

## Deploy to Vercel

Import the repository, set Framework Preset to Other, leave Build Command and Output Directory empty, and set the Root Directory to `constellation-site`. `vercel.json` adds security headers and a content security policy.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The only page |
| `js/app.js` | All app logic and charts |
| `js/config.js` | Optional Supabase URL and key |
| `supabase.sql` | One-time table and security setup |
| `css/site.css` | Styles |
| `sw.js`, `manifest.webmanifest` | Offline use and install to home screen |
