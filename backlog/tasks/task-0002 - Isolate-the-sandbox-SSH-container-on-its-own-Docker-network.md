---
id: TASK-0002
title: Isolate the sandbox SSH container on its own Docker network
status: To Do
assignee: []
created_date: '2026-11-25T19:14:42Z'
labels:
  - sandbox
  - devtools
dependencies: []
priority: medium
type: chore
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Problem: the sandbox sshd (npm run sandbox:ssh) runs on the default Docker bridge with ListenAddress 0.0.0.0, no password, and AllowTcpForwarding yes. Any other container on that bridge can log in as tester without a password (verified by the Opus plan; baseline test in the verification steps).

Decision: run the container on a dedicated user-defined bridge network yoke-sandbox-net created on first use with com.docker.network.bridge.enable_icc=false. Keep ListenAddress 0.0.0.0 and the empty password (the Remote-SSH "press Enter" workflow stays). Publish only -p 127.0.0.1:2222:2222 as now. Binding sshd to 127.0.0.1 inside the container does NOT work, because docker-proxy connects to the container IP, not its loopback. --network host was rejected (shares the devcontainer network namespace). Authentication stays off; the trust domain is the devcontainer, as already accepted.

Changes:
- package.json sandbox:ssh: create the network if missing (docker network inspect || docker network create --driver bridge -o com.docker.network.bridge.enable_icc=false yoke-sandbox-net), then docker run with --network yoke-sandbox-net. Leave the network after stop (removing it races the --rm removal).
- docker/sandbox/sshd_config: AllowTcpForwarding local (VS Code Remote-SSH needs -L/-D), AllowAgentForwarding no, AllowStreamLocalForwarding no, PermitTunnel no; update the header comment to describe the network isolation.
- docker/sandbox/README.md: describe the network, the forwarding limits, and "docker network rm yoke-sandbox-net" to remove it.

Verification (devcontainer):
1. Baseline on the CURRENT container (default bridge): a second container logs in with an empty password (expected LOGGED_IN; this is the problem).
2. After the change: container attached only to yoke-sandbox-net; enable_icc is false; docker port shows 127.0.0.1:2222.
3. ssh tester@127.0.0.1 id -un returns tester.
4. Local forward -L works (banner read through a tunnel); remote -R is refused.
5. Negative: a container on the default bridge, and a container on yoke-sandbox-net, cannot reach the container IP on port 2222 (timeout, exit 255).
6. Manual: VS Code Remote-SSH to yoke-sandbox, press Enter, run yoke --help.
7. npm run typecheck, npm test, npm run check all pass.

Rollback: revert the PR; npm run sandbox:ssh:stop; docker network rm yoke-sandbox-net; rebuild. If Remote-SSH breaks, restore AllowTcpForwarding yes and keep the network change.

Risks: unauthenticated access remains for everything in the devcontainer network namespace (accepted). Isolation relies on Docker firewall rules being active. If yoke-sandbox-net already exists with ICC enabled, the script reuses it silently: check it in step 2.

Action for the user: stop the currently running yoke-sandbox-ssh container once (npm run sandbox:ssh:stop) before the new version is started.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A second container on the default bridge cannot log in to the sandbox SSH port
- [ ] #2 A container on yoke-sandbox-net cannot log in to the sandbox SSH port
- [ ] #3 Remote-SSH still connects and forwards locally; remote forwards are refused
- [ ] #4 Typecheck, tests and lint pass
<!-- AC:END -->
