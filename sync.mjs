import {$, cd} from 'zx';
import fs from 'fs';
import path from 'path';
$.verbose = true;

const ROOT_DIR = process.cwd();
const MONOREPO_URL = 'https://github.com/formio/formio-monorepo';
const TEMP_DIR = path.resolve(ROOT_DIR, '..', 'tmp/formio-monorepo');
const MONOREPO_PACKAGE_LOCATION = process.env.MONOREPO_PACKAGE_LOCATION || 'apps/formio-server';
const SOURCE_REPO_OWNER = process.env.SOURCE_REPO_OWNER || 'formio';


async function cloneMonoRepo() {
  // check delete temp directory if exists
  try {
    await $`rm -rf ${TEMP_DIR}`;
  } catch (error) {
    console.error('Error deleting temp directory:', error);
  }
  // clone the monorepo with no history
  try {
    await $`git clone --depth 1 ${MONOREPO_URL}.git ${TEMP_DIR}`;
    console.log('Monorepo cloned successfully.');
  } catch (error) {
    console.error('Error cloning monorepo:', error);
    process.exit(1);
  }
}

async function createBranch(branchName) {
  console.log('Creating branch:', branchName);
  await cd(TEMP_DIR);
  try {
    await $`git checkout -b ${branchName}`;
    console.log(`Branch ${branchName} created successfully.`);
  } catch (error) {
    console.error('Error creating branch:', error);
    process.exit(1);
  }
  await cd(ROOT_DIR);
}

async function getMergedPullRequests(since) {
  console.log(`Getting merged PRs since ${since}...`);
  
  // If since is a number, treat it as a PR number
  // If it's a string that can be parsed as a date, treat it as a date
  // Otherwise, default to 7 days ago
  let query = '';
  if (!isNaN(parseInt(since))) {
    query = `?base=master&state=closed&sort=updated&direction=desc`;
  } else {
    const sinceDate = new Date(since) || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // default to 7 days ago
    query = `?base=master&state=closed&sort=updated&direction=desc&since=${sinceDate.toISOString()}`;
  }
  
  const url = `https://api.github.com/repos/${SOURCE_REPO_OWNER}/${process.env.SOURCE_REPO_NAME}/pulls${query}`;
  console.log(`Fetching PRs from: ${url}`);
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `token ${process.env.GH_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });
  
  if (!response.ok) {
    console.error(`GitHub API error: ${response.status} ${response.statusText}`);
    const error = await response.text();
    console.error(error);
    process.exit(1);
  }
  
  const prs = await response.json();
  
  // Filter to only merged PRs
  const mergedPRs = prs.filter(pr => pr.merged_at !== null);
  
  console.log(`Found ${mergedPRs.length} merged PRs`);
  
  if (typeof since === 'number') {
    // If we're filtering by PR number, keep only PRs with higher numbers
    return mergedPRs.filter(pr => pr.number > since);
  }
  
  return mergedPRs;
}

async function getPRDetails(prNumber) {
  console.log(`Getting details for PR #${prNumber}...`);
  
  const url = `https://api.github.com/repos/${SOURCE_REPO_OWNER}/${process.env.SOURCE_REPO_NAME}/pulls/${prNumber}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `token ${process.env.GH_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });
  
  if (!response.ok) {
    console.error(`GitHub API error: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  
  return await response.json();
}

async function getPRChanges(prNumber) {
  console.log(`Getting changes for PR #${prNumber}...`);
  
  const url = `https://api.github.com/repos/${SOURCE_REPO_OWNER}/${process.env.SOURCE_REPO_NAME}/pulls/${prNumber}/files`;
  console.log(`Fetching changes from: ${url}`);
  const response = await fetch(url, {
    headers: {
      'Authorization': `token ${process.env.GH_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });
  
  if (!response.ok) {
    console.error(`GitHub API error: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  
  const files = await response.json();
  
  // Convert GitHub's file change format to our format
  return files.map(file => {
    console.log('gh file:', file);
    // GitHub API uses 'status' values: added, modified, removed, renamed, etc.
    let status = file.status;
    
    // Convert to our format if needed
    if (status === 'added') status = 'added';
    else if (status === 'modified') status = 'modified';
    else if (status === 'removed') status = 'removed';
    else if (status === 'renamed') status = 'renamed';
    else status = 'unknown';
    
    return {
      status,
      path: file.filename,
      previous_path: status === 'renamed' ? file.previous_filename : undefined
    };
  });
}

async function syncChange(change) {
  console.log('Syncing change:', change);
  const { path: changedFilePath, status, previous_path } = change;
  const sourcePath = path.resolve(ROOT_DIR, changedFilePath);
  const targetPath = path.join(TEMP_DIR, process.env.MONOREPO_PACKAGE_LOCATION, changedFilePath);
  
  switch (status) {
    case 'added':
    case 'modified':
      console.log(`Copying ${sourcePath} to ${targetPath}`);
      // Ensure directory exists
      await $`mkdir -p ${path.dirname(targetPath)}`;
      // Copy file if it exists
      if (fs.existsSync(sourcePath)) {
        await $`cp ${sourcePath} ${targetPath}`;
      } else {
        console.warn(`Source file does not exist: ${sourcePath}`);
      }
      break;
      
    case 'removed':
      // Delete file if it exists
      console.log(`Removing ${targetPath}`);
      if (fs.existsSync(targetPath)) {
        await $`rm ${targetPath}`;
      }
      break;
      
    case 'renamed':
      // Handle renaming
      const previousTargetPath = path.join(TEMP_DIR, process.env.MONOREPO_PACKAGE_LOCATION, previous_path);
      console.log(`Renaming ${previousTargetPath} to ${targetPath}`);
      
      // Remove old file if it exists
      if (fs.existsSync(previousTargetPath)) {
        await $`rm ${previousTargetPath}`;
      }
      
      // Create new file if it exists in source
      if (fs.existsSync(sourcePath)) {
        await $`mkdir -p ${path.dirname(targetPath)}`;
        await $`cp ${sourcePath} ${targetPath}`;
      } else {
        console.warn(`Source file does not exist: ${sourcePath}`);
      }
      break;
  }
}

async function syncPR(pr) {
  const prNumber = pr.number;
  const prTitle = pr.title;
  const prUser = pr.user.login;
  
  console.log(`Syncing PR #${prNumber}: "${prTitle}" by ${prUser}`);
  
  // Generate a branch name for this PR
  const branchName = `sync-pr-${prNumber}-${Date.now().toString().slice(-6)}`;
  
  // Create a new branch in the monorepo
  await createBranch(branchName);
  
  // Get the changes from this PR
  const changes = await getPRChanges(prNumber);
  
  // Apply each change
  for (const change of changes) {
    await syncChange(change);
  }
  
  // Check if we have any changes to commit
  await cd(TEMP_DIR);
  const { stdout: gitStatus } = await $`git status --porcelain`;
  
  if (!gitStatus.trim()) {
    console.log(`No changes to commit for PR #${prNumber}`);
    return null;
  }
  
  // Configure git with PR author details when available
  const authorName = pr.user.name || pr.user.login;
  const authorEmail = pr.user.email || `${pr.user.login}@users.noreply.github.com`;
  
  await $`git config user.name "${authorName}"`;
  await $`git config user.email "${authorEmail}"`;
  
  
  // Add all changes
  await $`git add .`;
  
  // Create commit message with reference to original PR
  const commitMessage = `Sync changes from PR #${prNumber}: ${prTitle}\n\nOriginal PR: ${pr.html_url}`;
  await $`git commit -m ${commitMessage}`;
  
  // Push the branch
  await $`git push -u origin ${branchName}`;
  
  // Create a PR in the monorepo
  // Prepare PR body with attribution and original description
  let prBody = `This PR syncs changes from [${process.env.SOURCE_REPO_NAME} PR #${prNumber}](${pr.html_url}) by @${prUser}.\n\n`;
  
  // Add original PR description
  if (pr.body) {
    prBody += `## Original PR Description\n\n${pr.body}\n\n`;
  }
  
  // Add notice about automated syncing
  prBody += `## Note\n\nThis PR was automatically created by the repository sync tool.`;
  
  const response = await fetch(`https://api.github.com/repos/formio/formio-monorepo/pulls`, {
    method: 'POST',
    headers: {
      'Authorization': `token ${process.env.GH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: `[Sync PR #${prNumber}] ${prTitle}`,
      body: prBody,
      head: branchName,
      base: 'main'
    })
  });
  
  if (!response.ok) {
    console.error(`Failed to create PR: ${response.status} ${response.statusText}`);
    const error = await response.text();
    console.error(error);
    return null;
  }
  
  const prData = await response.json();
  console.log(`Created monorepo PR: ${prData.html_url}`);
  
  return prData;
}

export async function sync() {
  // repo name from command line or environment variable
  
  // last synced PR number or date from command line or environment variable
  const prNumber = process.argv[2] || process.env.PR_NUMBER;

  
  
  if(!prNumber) {
    console.error('Please provide a PR number or date to sync from.');
    process.exit(1);
  }
  if(!process.env.GH_TOKEN) {
    console.error('Please set the GH_TOKEN environment variable with a valid GitHub token.');
    process.exit(1);
  }
  if(!process.env.MONOREPO_PACKAGE_LOCATION) {
    console.error('Please set the MONOREPO_PACKAGE_LOCATION environment variable with the relative monorepo path to package.');
    process.exit(1);
  }

  if(!process.env.SOURCE_REPO_NAME) {
    console.error('Please set the SOURCE_REPO_NAME environment variable with the name of the source repo.');
    process.exit(1);
  }

  
  // Clone monorepo
  await cloneMonoRepo();
  
  // Get all merged PRs since the specified reference point
  
  // Get detailed PR information including body
  const prDetails = await getPRDetails(prNumber);
    
    // Sync this PR to the monorepo
  await syncPR(prDetails);
    
  
  console.log('Sync completed successfully!');
}
