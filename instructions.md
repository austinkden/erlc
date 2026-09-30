# Instructions: Adding ERLC Road Studio to `austinkden/erlc`

This guide explains how to add the **ERLC Road Studio** codebase to your existing GitHub repository:
**`https://github.com/austinkden/erlc`**

---

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Method 1: Push this Folder Directly to the GitHub Repo (Root Directory)](#method-1-push-this-folder-directly-to-the-github-repo-root-directory)
3. [Method 2: Add into an Existing Cloned Repo as a Subfolder (e.g., `tools/road-studio`)](#method-2-add-into-an-existing-cloned-repo-as-a-subfolder-eg-toolsroad-studio)
4. [Method 3: Deploy to GitHub Pages (Free Live Web Hosting)](#method-3-deploy-to-github-pages-free-live-web-hosting)
5. [Recommended `.gitignore`](#recommended-gitignore)
6. [Troubleshooting Common Issues](#troubleshooting-common-issues)

---

## Prerequisites
- **Git** is installed on your computer (`git --version`).
- You have push access to `https://github.com/austinkden/erlc`.
- You are authenticated with GitHub via SSH key or GitHub Personal Access Token (or GitHub Credential Manager / `gh auth login`).

---

## Method 1: Push this Folder Directly to the GitHub Repo (Root Directory)

Use this method if you want this repository's root to contain the Road Studio (`index.html`, `css/`, `js/`, `resources/`).

Open PowerShell or Command Prompt in `c:\Users\austi\VSCode\erlcmaps` and run:

```powershell
# 1. Navigate to the project folder (if not already there)
cd c:\Users\austi\VSCode\erlcmaps

# 2. Initialize a local git repository
git init -b main

# 3. Add all project files
git add .

# 4. Commit the initial build
git commit -m "feat: complete ERLC Road Studio with Reicon, pathfinding, and diagnostics"

# 5. Link to your GitHub repository
git remote add origin https://github.com/austinkden/erlc.git
# (Or using SSH if configured: git remote add origin git@github.com:austinkden/erlc.git)

# 6. If the remote repo is empty, push directly:
git push -u origin main

# 6b. If the remote repo already has files (like a README or LICENSE), pull and merge first:
git pull origin main --allow-unrelated-histories
git push -u origin main
```

---

## Method 2: Add into an Existing Cloned Repo as a Subfolder (e.g., `tools/road-studio`)

If your `austinkden/erlc` repository already contains other code (e.g., Discord bot, game scripts, or documentation) and you want the road mapper to live inside a subfolder:

```powershell
# 1. Assuming your erlc repo is cloned at c:\Users\austi\VSCode\erlc
# Create the target directory inside it
New-Item -ItemType Directory -Force -Path "c:\Users\austi\VSCode\erlc\road-studio"

# 2. Copy all files from erlcmaps to the destination (excluding temporary system files)
Copy-Item -Path "c:\Users\austi\VSCode\erlcmaps\*" -Destination "c:\Users\austi\VSCode\erlc\road-studio" -Recurse -Force

# 3. Navigate into your erlc repository
cd c:\Users\austi\VSCode\erlc

# 4. Stage and commit the new subfolder
git add road-studio/
git commit -m "feat: add ERLC Road Studio interactive road network editor"

# 5. Push changes to GitHub
git push origin main
```

---

## Method 3: Deploy to GitHub Pages (Free Live Web Hosting)

Because ERLC Road Studio is built with modern vanilla HTML, CSS, ES6 JavaScript, and Reicon via CDN, it has **zero server requirements** and can run 100% for free on **GitHub Pages**:

1. Once the code is pushed to your repo `austinkden/erlc`:
2. Go to **GitHub.com** → navigate to `austinkden/erlc`.
3. Click on the **Settings** tab (top right of the repository page).
4. In the left sidebar, click **Pages**.
5. Under **Build and deployment**:
   - **Source**: Select `Deploy from a branch`.
   - **Branch**: Select `main` (or the branch you pushed to), and folder `/ (root)` (or `/road-studio` if you used Method 2).
   - Click **Save**.
6. Within 1-2 minutes, your editor will be live on the web at:
   ```
   https://austinkden.github.io/erlc/
   ```
   Anyone on your team can open this link in any browser, map roads, simulate routes, and export JSON/Lua with zero installation!

---

## Recommended `.gitignore`

Create a file named `.gitignore` in the project root if you want to avoid tracking OS cache files or local scratch files:

```gitignore
# Operating System files
.DS_Store
Thumbs.db
desktop.ini

# Editor & IDE files
.vscode/
.idea/
*.swp
*.swo

# Local logs & scratch scripts
*.log
scratch/
```

---

## Troubleshooting Common Issues

### 1. `error: remote origin already exists`
If you previously added a remote:
```powershell
git remote set-url origin https://github.com/austinkden/erlc.git
```

### 2. `error: failed to push some refs to ...`
This happens when GitHub has commits that your local folder does not have:
```powershell
git pull origin main --rebase
git push origin main
```
Or if you want to cleanly merge unrelated initial histories:
```powershell
git pull origin main --allow-unrelated-histories
git push origin main
```

### 3. Authentication prompt
If Git asks for username and password:
- Use your **GitHub username**.
- For password, use a **Personal Access Token (Classic or Fine-grained)** with `repo` scope generated from [GitHub Settings → Developer Settings → Personal access tokens](https://github.com/settings/tokens).
- Or use the GitHub CLI to authenticate once:
  ```powershell
  winget install GitHub.cli
  gh auth login
  ```
