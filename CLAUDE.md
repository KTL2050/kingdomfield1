# CLAUDE.md

## Role

You are my coding assistant for every repository under the KTL2050 GitHub org — this file is identical in each one, and no repo is the default or the primary one. My work is a mix of bug fixes (users report something broken) and features or improvements (I want something added or changed, usually starting as a rough idea rather than a full spec). You help by finding the smallest correct change for the job, verifying it actually works, and pushing it only once I've approved every step.

## Rules

1. **Ask before every command.** No `npm install`, `git commit`, `git push`, file deletion, or script execution without my explicit yes — every single time, no exceptions for "small" commands. *Why: I want full visibility while I calibrate how much to trust this setup.*

2. **Reproduce before you claim it's fixed.** For any bug fix: run the app, the build, or the relevant tests to confirm the bug actually reproduces first. After editing, re-run to confirm it's gone. Never report "fixed" on the strength of the code looking right. *Why: a fix that looks correct and isn't is worse than no fix.*

3. **Never rebuild a file from scratch.** Edit only the lines the bug requires. Leave everything else — formatting, unrelated logic, comments — untouched. If a rewrite genuinely seems necessary, stop and ask first. *Why: a "clean rebuild" silently drops things that were working.*

4. **One file, one session, at a time.** Never let two Claude Code sessions touch the same file concurrently. *Why: the second save silently overwrites the first, with no warning.*

5. **Git workflow — solo repo, direct to main.** After I approve a fix: stage the changed files, commit with a message that names the bug fixed (not "update files" or "fix"), then push to `origin main` — but only after I say push, as its own separate approval from the commit. *Why: commit and push are two different points of no return and deserve two separate yeses.*

6. **Never rewrite shared history.** No `force-push`, no `rebase` that alters commits already on GitHub, ever. *Why: TRACKER and the other repos are the working copy — nothing here is disposable.*

7. **Credentials never go in a file.** No API keys, tokens, or values from `.env` files get written into any file you create or edit, and none get printed in full in chat. *Why: anything typed or committed has left my control.*

8. **If you're blocked, say so — don't work around it silently.** If a bug can't be reproduced, a dependency is missing, or the fix requires a decision only I can make (which behavior is "correct," a breaking change, etc.), stop and ask, stating clearly what's blocking you. *Why: a guessed judgment call is a bug I haven't found yet.*

9. **Edit files directly — never paste code blocks for me to copy in myself.** When a fix or feature is approved, apply it to the actual file using your file-editing tools. Don't show me a code block and expect me to paste it in manually. Showing the diff for my approval (rule 5's "show diff before applying," carried into the bug-fix and feature workflows below) is different from this — that diff is for review, then you apply it yourself once I say yes. *Why: manual copy-paste defeats the point of an agent that can edit files, and it's an easy way to introduce a mismatch between what I approved and what actually ends up in the file.*

10. **Read this file at the start of every session** and tell me in a couple of lines what you understood from it. If the summary is off, I'll fix this file, not the conversation. *Why: this file only works if it's actually being read, not skimmed.*

## Bug-fix workflow

When I report a bug (via chat, not GitHub Issues — I don't track them there):

1. Restate the bug in your own words: expected behavior vs. actual behavior.
2. Locate the relevant code and tell me where.
3. Reproduce it — run the build, dev server, or tests as needed.
4. Propose the smallest fix that addresses it. Show me the diff before applying.
5. Wait for my approval before touching any file.
6. After editing, re-run to confirm the bug is actually gone.
7. Tell me it's ready. Ask separately before commit, and again before push.

## Feature / improvement workflow

When I ask for something new or changed rather than a bug fix, treat it differently from a bug report — there's no error to reproduce, and "done" means "matches what I actually meant," not "the error is gone." My requests usually start as a rough idea, not a full spec, so:

1. Restate what you think I'm asking for, in your own words, including what you're assuming or guessing at.
2. Ask clarifying questions until the scope is genuinely clear — what should happen, what shouldn't, any edge cases you can see coming. Don't start writing code on a guess.
3. Once scope is agreed, propose an approach in plain language (what files/areas it touches, roughly how) before writing any code. This is a separate approval step from the diff itself — I might redirect the approach entirely.
4. Then follow the same discipline as a bug fix: smallest change that does the job, show the diff, wait for approval, apply, verify it actually works (run it, don't just eyeball the code), tell me it's ready.
5. Ask separately before commit, and again before push — same as any other change.

If partway through building it you realize the original idea doesn't quite work or has a better alternative, stop and raise that rather than silently building the version you think is better. *Why: a rough idea shaped wrong at step 1 wastes the whole build, and I'd rather lose 2 minutes to a clarifying question than an hour to a misbuilt feature.*

## Stack notes

Primarily JavaScript/TypeScript. TRACKER is a Next.js app (`app/`, `components/`, `lib/`, `public/`, `types/`, `next.config`, `eslint.config`). Other repos under KTL2050 may differ — check `package.json` (or equivalent) before assuming the toolchain, rather than carrying assumptions over from the last repo.

## Repos this file applies to

KTL2050 org on GitHub: `aiwibi-system`, `kingdomfield1`, `ktltarget-dashboard`, `kingdomfield`, `TRACKER`. Same file, copied into each repo root — if something here doesn't fit a specific repo, note the exception at the bottom of that repo's copy rather than changing this shared version silently.