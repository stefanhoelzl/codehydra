#[cfg(test)]
use git2::{IndexAddOption, Repository, Signature};
#[cfg(test)]
use std::path::{Path, PathBuf};
#[cfg(test)]
use tempfile::TempDir;

#[cfg(test)]
pub struct TestRepo {
    pub temp_dir: TempDir,
    pub repo: Repository,
}

#[cfg(test)]
impl TestRepo {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let temp_dir = TempDir::new()?;
        let repo = Repository::init(temp_dir.path())?;

        // Create file for initial commit
        let readme_path = temp_dir.path().join("README.md");
        std::fs::write(&readme_path, "# Test Repository\n")?;

        {
            let mut index = repo.index()?;
            index.add_path(Path::new("README.md"))?;
            index.write()?;

            let tree_id = index.write_tree()?;
            let tree = repo.find_tree(tree_id)?;
            let sig = Signature::now("Test User", "test@example.com")?;

            repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])?;
        }

        Ok(Self { temp_dir, repo })
    }

    pub fn path(&self) -> &Path {
        self.temp_dir.path()
    }

    pub fn create_branch(&self, name: &str) -> Result<(), Box<dyn std::error::Error>> {
        let head = self.repo.head()?;
        let commit = head.peel_to_commit()?;
        self.repo.branch(name, &commit, false)?;
        Ok(())
    }

    pub fn create_worktree(
        &self,
        name: &str,
        branch: &str,
    ) -> Result<PathBuf, Box<dyn std::error::Error>> {
        self.create_branch(branch)?;

        // Create worktree in a subdirectory of temp_dir to avoid conflicts
        let worktree_path = self.temp_dir.path().join(format!("worktrees/{name}"));
        std::fs::create_dir_all(worktree_path.parent().unwrap())?;

        // Create worktree and checkout the branch
        let branch_ref = self.repo.find_branch(branch, git2::BranchType::Local)?;
        let branch_ref = branch_ref.get();

        let mut opts = git2::WorktreeAddOptions::new();
        opts.reference(Some(branch_ref));
        self.repo.worktree(name, &worktree_path, Some(&opts))?;

        Ok(worktree_path)
    }

    pub fn detach_head(&self) -> Result<(), Box<dyn std::error::Error>> {
        let head = self.repo.head()?;
        let commit = head.peel_to_commit()?;
        self.repo.set_head_detached(commit.id())?;
        Ok(())
    }

    /// Create a modified (unstaged) file in a worktree.
    /// Modifies an existing tracked file to create an unstaged change.
    pub fn create_modified_file(
        &self,
        worktree_path: &Path,
        filename: &str,
        content: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let file_path = worktree_path.join(filename);

        // If the file doesn't exist, we need to create and track it first
        if !file_path.exists() {
            // Create, add, and commit the file first
            std::fs::write(&file_path, "initial content")?;
            let repo = Repository::open(worktree_path)?;
            let mut index = repo.index()?;
            index.add_path(Path::new(filename))?;
            index.write()?;

            let tree_id = index.write_tree()?;
            let tree = repo.find_tree(tree_id)?;
            let sig = Signature::now("Test User", "test@example.com")?;
            let parent = repo.head()?.peel_to_commit()?;
            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                "Add file for modification",
                &tree,
                &[&parent],
            )?;
        }

        // Now modify it (this creates an unstaged change)
        std::fs::write(&file_path, content)?;
        Ok(())
    }

    /// Create a staged file in a worktree.
    /// Creates a new file and stages it without committing.
    pub fn create_staged_file(
        &self,
        worktree_path: &Path,
        filename: &str,
        content: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let file_path = worktree_path.join(filename);
        std::fs::write(&file_path, content)?;

        let repo = Repository::open(worktree_path)?;
        let mut index = repo.index()?;
        index.add_path(Path::new(filename))?;
        index.write()?;

        Ok(())
    }

    /// Create an untracked file in a worktree.
    pub fn create_untracked_file(
        &self,
        worktree_path: &Path,
        filename: &str,
        content: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let file_path = worktree_path.join(filename);
        std::fs::write(&file_path, content)?;
        Ok(())
    }

    /// Delete a tracked file in a worktree (creates a deleted status).
    pub fn delete_tracked_file(
        &self,
        worktree_path: &Path,
        filename: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let file_path = worktree_path.join(filename);

        // Ensure the file exists and is tracked
        if !file_path.exists() {
            // Create, add, and commit the file first
            std::fs::write(&file_path, "content to delete")?;
            let repo = Repository::open(worktree_path)?;
            let mut index = repo.index()?;
            index.add_path(Path::new(filename))?;
            index.write()?;

            let tree_id = index.write_tree()?;
            let tree = repo.find_tree(tree_id)?;
            let sig = Signature::now("Test User", "test@example.com")?;
            let parent = repo.head()?.peel_to_commit()?;
            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                "Add file for deletion",
                &tree,
                &[&parent],
            )?;
        }

        // Now delete it
        std::fs::remove_file(&file_path)?;
        Ok(())
    }

    /// Stage all changes in a worktree (for testing staged + modified scenarios).
    pub fn stage_all_changes(
        &self,
        worktree_path: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let repo = Repository::open(worktree_path)?;
        let mut index = repo.index()?;
        index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)?;
        index.write()?;
        Ok(())
    }
}
