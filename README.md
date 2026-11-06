# Bizaro Track — messaging core (PWA)
    node server.js                 # http://localhost:3000   (Node >= 22.13, no npm install)
    DEV_OTP=1 node server.js       # local login: OTP is shown on screen (no SMS provider integrated)
    npm test                       # 13 backend tests      | python3 test/e2e.py  # 9 browser tests (needs playwright)
    node test/load.js              # load test
Production env: `ACCESS_CODE` (required, invite code), `DATA_DIR` (persistent disk), `NODE_ENV=production`, `TRUST_PROXY=1` behind a proxy.
Login needs an SMS provider (not integrated). Until then `DEV_OTP=1` + `ACCESS_CODE` = invite-only private-team mode (phone ownership is NOT verified). See docs/ARCHITECTURE.md.
