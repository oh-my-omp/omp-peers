# Changelog

## [Unreleased]

## [0.2.2] - 2026-11-21

### Fixed

- omp-peers loads again on omp 19 (it imported getDaemonRuntimeRoot, which omp 19 removed)

### Removed

- peer_list no longer lists omp processes that are not bridged, because omp 19 no longer exposes them to plugins

## [0.2.1] - 2026-11-19

### Changed

- Updated the shared copy of `i18n.ts` to oh-my-omp/shared@33dbe00.

## [0.2.0] - 2026-11-15

### Added

- Added Windows support: processes listen on per-user named pipes and peer discovery finds live peers from the pipe namespace

## [0.1.10] - 2026-11-12

### Changed

- 发布改为 omomp 的每日发布：合并到 main 不再升版本号，提交在 `## [Unreleased]` 下用 lgit 写条目；每天 02:00 GMT+9 由共享 workflow 把这一节发布到 `release` 分支、`v<version>` tag 与 GitHub Release；安装改为 `https://github.com/oh-my-omp/omp-peers#release`。
