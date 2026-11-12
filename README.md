[README.md](https://github.com/user-attachments/files/34772277/README.md)
# The Separation Test — shared 24-hour cache

This version uses **Upstash Redis** as a shared cache so different devices receive identical analyses for 24 hours. No database login is required for visitors.

## Setup

1. Create a free Upstash Redis database at https://console.upstash.com/ (choose Redis, enable REST API). Copy **REST URL** and **REST TOKEN** from the database's REST API details.
2. In Vercel → your project → Settings → Environment Variables, create:
   - `UPSTASH_REDIS_REST_URL` = your database's HTTPS REST URL
   - `UPSTASH_REDIS_REST_TOKEN` = your database's REST token
   - Keep existing `OPENAI_API_KEY` (your secret OpenAI API key).
   Apply all three to **Production**. Do not put tokens in GitHub or in `index.html`.
3. Replace your repository files with this folder's contents, preserving `api/research.js`. Commit the changes. Vercel should deploy automatically; redeploy after changing environment variables.
4. Search for the same person twice (ideally on two devices). The second search should say **Cached result** and show the exact same analysis and research date.

## Behavior and limitations

- Names are normalized for case, Unicode compatibility, and whitespace. Different spellings or aliases may still be treated as different people. Namesakes require identity disambiguation before a truly robust public release.
- First request for a normalized name calls the AI once, then stores the full result for **86,400 seconds**. Repeat requests use Redis only. A distributed lock prevents simultaneous duplicate requests for the same normalized name. If research is in progress, other visitors may be asked to retry.
- A cache entry expires 24 hours after the original research. The next request researches afresh.
- An Upstash free tier has usage limits. If storage is unavailable, the backend refuses to initiate paid research to avoid uncached repeat charges.
- **This is not a global spending cap.** Different people can still trigger paid requests. Keep auto-recharge off and monitor OpenAI usage. A server-side global search quota is a separate enhancement.
- Research and scores are interpretive, not objective facts; check sources. Do not treat accusations as established wrongdoing.
