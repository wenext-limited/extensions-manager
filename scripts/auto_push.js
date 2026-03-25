const { execSync } = require('child_process');
const fs = require('fs');

try {
    const status = execSync('git status', { encoding: 'utf8' });
    console.log('--- STATUS ---');
    console.log(status);
    
    const remote = execSync('git remote -v', { encoding: 'utf8' });
    console.log('--- REMOTE ---');
    console.log(remote);
    
    // Add all
    execSync('git add .', { encoding: 'utf8' });
    
    // Commit
    try {
        execSync('git commit -m "fix: refactor pack scripts and handle temporary directory bug"', { encoding: 'utf8' });
        console.log('Committed successfully.');
    } catch (e) {
        console.log('Nothing to commit or commit failed:', e.message);
    }
    
    // Push
    // Check if branch upstream is set
    try {
        execSync('git push', { encoding: 'utf8' });
        console.log('Pushed successfully.');
    } catch (e) {
        console.log('Push failed:', e.message);
        // try to get current branch
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
        console.log(`Trying to push and set upstream to origin ${branch}`);
        try {
            execSync(`git push --set-upstream origin ${branch}`, { encoding: 'utf8' });
            console.log('Pushed with upstream successfully.');
        } catch (err) {
            console.log('Failed to push with upstream:', err.message);
        }
    }
} catch (e) {
    console.error('Error:', e.message);
}
