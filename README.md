# IIFL Trader Terminal

A desktop-style Market Watch and Action Watch inspired by the supplied IIFL Terminal references. It runs with moving simulation data until an IIFL Markets session is connected.

## Run locally

```powershell
cd server
npm install
npm start
```

Open [http://localhost:3001](http://localhost:3001). Press **F7** or select **Market Analysis** to open the second Action Watch screen.

## IIFL Markets daily login

1. Copy `server/.env.example` to `server/.env`.
2. Set `IIFL_APP_KEY`, `IIFL_APP_SECRET`, and the exact redirect URI registered in the IIFL Developer Portal. The IIFL trading client ID is user-specific and is never stored in configuration.
3. On the terminal, choose **Connect IIFL**. The browser goes to IIFL's official login page; your app does not collect the brokerage password, OTP, PIN, or access token.
4. IIFL redirects to `/auth/callback`. The server exchanges the authorization code at `POST /getusersession`, retains the returned Bearer token in server memory, and requests market quotes with `Authorization: Bearer <token>`.

The backend follows the current IIFL Markets flow, not the retired Blaze `/auth/login` flow. The market-data call uses IIFL's `/marketdata/marketquotes` endpoint through the backend only.

## AWS deployment

Set the same environment values on the whitelisted EC2 instance and register its public HTTPS callback URL with IIFL. Do not use a browser `localhost` redirect URI in production. For a multi-user or multi-instance deployment, replace the in-memory session variable in `server/index.js` with an encrypted Redis or database-backed token store before scaling.

Never place the app secret, brokerage credentials, authorization code, or access token in frontend files, a Git repository, logs, or browser storage.
