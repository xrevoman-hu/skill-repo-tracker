# Skill Repo Tracker v1.1.8 Promotion Kit

This folder contains the v1.1.8 WeChat article, cover image, article assets,
real app screenshots, review notes, and install-validation notes.

## Core Message

Skill Repo Tracker is not a tool for blindly installing more AI Skills. It is a
local workbench for turning scattered GitHub repositories, Skills, plugin
install entries, notes, backups, tasks, and migration data into inspectable
facts before the user acts.

## Visual Preview

<p>
  <img src="product-logo.png" alt="Skill Repo Tracker logo" width="96" />
</p>

<p>
  <img src="wechat-cover.png" alt="WeChat cover" width="520" />
</p>

The article uses the user-provided real v1.1.8 app screenshots as page evidence:

<table>
  <tr>
    <td><strong>GitHub</strong><br /><img src="article-assets/10-github-workbench.png" alt="GitHub page" width="360" /></td>
    <td><strong>Repositories</strong><br /><img src="article-assets/11-repositories-note.png" alt="Repositories page" width="360" /></td>
  </tr>
  <tr>
    <td><strong>Skills</strong><br /><img src="article-assets/12-skills.png" alt="Skills page" width="360" /></td>
    <td><strong>Plugins</strong><br /><img src="article-assets/13-plugins.png" alt="Plugins page" width="360" /></td>
  </tr>
  <tr>
    <td><strong>Tasks</strong><br /><img src="article-assets/14-tasks.png" alt="Tasks page" width="360" /></td>
    <td><strong>Settings</strong><br /><img src="article-assets/15-settings-migration.png" alt="Settings page" width="360" /></td>
  </tr>
</table>

## Contents

- `wechat-article.md`: Simplified Chinese WeChat article draft.
- `product-logo.png`: product logo copied from the app icon.
- `wechat-cover.png`: WeChat cover image, 900x383.
- `article-assets/`: hand-drawn article illustrations and resized app screenshots.
- `ux-evidence/`: original real v1.1.8 app screenshots used as evidence.
- `review.md`: independent review checklist, findings, and final status.
- `install-validation.md`: local DMG install verification record.
- `asset-prompts.md`: source prompts and image QA notes for the final illustrations.

## Publishing Boundary

The v1.1.8 DMG is intended for zero-cost GitHub Release distribution as an
ad-hoc signed local installation package. It can be mounted, copied to
`/Applications`, and manually allowed by macOS Gatekeeper.

It is not a Developer ID signed and Apple-notarized public release. Do not
describe it as a no-warning installer unless that signing and notarization
chain is completed.
