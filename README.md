# “THE SEPARATION TEST” — one-day beta

A lightweight website with live OpenAI web research, a two-score editorial assessment, sourced links, verdict and philosophical reflection.

## Deploy on Vercel

1. Create an OpenAI API key at https://platform.openai.com/api-keys and enable API billing. Keep the key private.
2. Create a free GitHub repository, upload `index.html`, `api/research.js`, `package.json`, and `vercel.json` (preserve folders).
3. Sign in to https://vercel.com, choose **Add New → Project**, import the GitHub repository and deploy.
4. In Vercel **Project Settings → Environment Variables**, add `OPENAI_API_KEY` with your key. Do **not** prefix with `NEXT_PUBLIC_`. Redeploy after adding it.
5. Open your `*.vercel.app` URL and search for a well-known public figure. Share that URL with friends.
6. After the test, disable the deployment or remove the API key from the Vercel project and redeploy.

## Important limitations

- **Costs:** Each search incurs API token and web-search charges. A $5 target is a budget, not a guaranteed maximum. Configure billing notifications/limits in your OpenAI account; also monitor usage and remove the key when done. API billing settings are not necessarily a hard real-time spending cap.
- **Rate limits:** The per-IP 8/day limit is *best-effort per serverless instance*, not a global or tamper-proof quota. Public links can generate unexpected usage. For a reliable global limit, add a persistent rate limiter (e.g., Redis/Upstash) or require login.
- **Citations:** Source links are gathered from OpenAI's web-search citations. The model's claims may still be incomplete or wrong. Always inspect the original sources. Some searches may return no citations; the UI warns accordingly.
- **Scores:** Subjective and contestable, not objective statements about a person's worth. If evidence is sparse or identity is ambiguous, scores should be omitted.
- **No durable cache:** Results are not saved between users; repeat searches cost money. Add a persistent database/cache before a larger launch.
- **Privacy:** Names searched are sent to the OpenAI API. Do not use this to profile private individuals.
- **Timeout:** Some complex searches may time out under the hosting plan.

## Local development

Install Node.js and Vercel CLI (`npm i -g vercel`). Set `OPENAI_API_KEY` in `.env.local` and run `vercel dev` in the project folder. Do not put your API key in the HTML file.
