# Yahoo Mail MCP connector for Claude

This connector runs on your PC and lets Claude, in the Claude desktop app, list folders, search, read, move, flag and organise your Yahoo Mail.
It never permanently deletes anything. "Delete" means moving to Trash.

Allow about 30 minutes.

---

## Step 1: Create a Yahoo app password
An app password is a separate password just for this connector. Your real password stays private, and you can revoke the app password at any time. Yahoo only offers app passwords once 2-step verification is turned on.
1. Go to https://login.yahoo.com/account/security and click **Generate app password** (or "Manage app passwords").
2. Name it `Claude`, then click **Generate**.
3. Copy the 16-letter password somewhere safe for the next few minutes. **Don't paste it into a chat with Claude.**

## Step 2: Install Node.js (skip this if you already have it)
1. Open **PowerShell** and type `node -v`. If you see a version like `v20.x` or higher, skip to Step 3.
2. Otherwise download the **LTS** installer from https://nodejs.org, run it with the default options, then close and reopen PowerShell.

## Step 3: Put the connector on your PC
1. Create a folder: `C:\Users\<your-username>\yahoo-mail-mcp`
2. Save `index.js` and `package.json` (the files Claude gave you) into that folder.
3. In PowerShell, run:
   ```powershell
   cd $HOME\yahoo-mail-mcp
   npm install
   ```

## Step 4: Test the login
Still in PowerShell, run these lines. Use your real Yahoo address and the app password from Step 1:
```powershell
$env:YAHOO_EMAIL = "you@yahoo.com"
$env:YAHOO_APP_PASSWORD = "your-16-letter-app-password"
npm run test-login
```
You should see `Login OK. Folders: Inbox, Sent, Draft, Trash, Bulk, ...`.
If you see `Login failed`, check the address, and make sure you used the **app password**, not your normal password.

## Step 5: Add it to the Claude desktop app
1. In the Claude desktop app, open **Settings → Developer → Edit Config**. This opens `claude_desktop_config.json`, which lives in `%APPDATA%\Claude\`.
2. Add a `yahoo-mail` entry under `mcpServers`. If the file is empty, replace everything with this:
   ```json
   {
     "mcpServers": {
       "yahoo-mail": {
         "command": "node",
         "args": ["C:\\Users\\<your-username>\\yahoo-mail-mcp\\index.js"],
         "env": {
           "YAHOO_EMAIL": "you@yahoo.com",
           "YAHOO_APP_PASSWORD": "your-16-letter-app-password"
         }
       }
     }
   }
   ```
   - Replace `<your-username>` with your Windows username. Note the **double backslashes**.
   - If the file already has other servers, add the `"yahoo-mail": { ... }` block inside the existing `mcpServers` and separate it with a comma.
3. Save the file, then **fully quit** the Claude desktop app (right-click the tray icon and choose Quit) and reopen it.

## Step 6: Try it
In a new chat in the desktop app, ask:
- "List my Yahoo folders"
- "Search my Yahoo inbox for bills from the last 6 months"
- "Move all Yahoo emails from linkedin.com into a folder called LinkedIn"

---

## What Claude can do with it
| Tool | What it does |
|---|---|
| `list_folders` | Shows all folders with total and unread counts |
| `search_emails` | Searches by sender, subject, text, date range, or unread only |
| `read_email` | Opens one email's full text and lists its attachments |
| `move_emails` | Moves chosen emails to another folder (or Trash) |
| `move_matching` | Moves **every** email from a sender or subject in one go, creating the folder if needed |
| `create_folder` | Makes a new folder or sub-folder |
| `mark_emails` | Marks emails read/unread or flagged/unflagged |

## Safety notes
- The app password sits in your config file on your PC. Keep that PC locked.
- To disconnect at any time, delete the app password in Yahoo's Account Security page. The connector stops working immediately.
- Nothing is ever permanently deleted. Moved emails can always be moved back.

## Troubleshooting
- **Yahoo tools don't appear in Claude:** check the JSON for missing commas or single backslashes, then fully quit and reopen the app. Settings → Developer shows the server's status and any error.
- **"node is not recognized":** reinstall Node.js (Step 2), or use the full path `"C:\\Program Files\\nodejs\\node.exe"` as the `command`.
- **Login failed:** regenerate the app password and update it in both the test and the config file.
