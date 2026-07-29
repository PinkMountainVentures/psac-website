# Deploying the Plan Your Day form backend

This connects the custom "Plan Your Day" form on the homepage to a Google Sheet. No server, no cost.

## 1. Create the spreadsheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new blank spreadsheet.
2. Name it something like **PSAC — Plan Your Day Submissions**.

## 2. Add the script

1. In the spreadsheet, go to **Extensions → Apps Script**.
2. Delete the placeholder `Code.gs` content and paste in the contents of `apps-script/Code.gs` from this folder.
3. Click the save icon (or Cmd+S).

## 3. Run it once to authorize

1. In the Apps Script toolbar, select the function dropdown (next to Debug) and choose **testSetup**.
2. Click **Run**.
3. Google will ask you to authorize the script — click through **Review permissions → (choose your account) → Advanced → Go to [project name] (unsafe) → Allow**. This is normal for scripts you write yourself; Google just doesn't have a "verified" badge for personal scripts.
4. Check the spreadsheet — a new **Submissions** tab should appear with a header row.

## 4. Deploy as a Web App

1. In Apps Script, click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill in:
   - Description: `Plan Your Day intake`
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**.
5. Authorize again if prompted.
6. Copy the **Web app URL** shown (ends in `/exec`).

## 5. Connect it to the site

1. Open `adventure-form.js`.
2. Find this line near the top:
   ```js
   var SUBMIT_ENDPOINT = "";
   ```
3. Paste your URL between the quotes:
   ```js
   var SUBMIT_ENDPOINT = "https://script.google.com/macros/s/XXXXXXXX/exec";
   ```
4. Save, commit, and push.

## 6. Test it

1. Open the live site, click **Start My Adventure**, fill out the form, and hit **Reserve My Spot**.
2. Check the Submissions tab — a new row should appear within a few seconds.

## Notes

- Every time you click **Deploy → New deployment** in Apps Script it generates a **new URL** — if you ever redeploy, update `SUBMIT_ENDPOINT` again. To update the script without changing the URL, use **Deploy → Manage deployments → edit (pencil) → New version**.
- The "Raw JSON" column in the sheet keeps the full untouched submission in case you need to pull a field the readable columns don't cover.
- This has no meaningful usage limits or cost at PSAC's scale — Apps Script Web Apps are free.
