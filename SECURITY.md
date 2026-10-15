# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration holds:

- the Hydrawise e-mail, password and API key, in the Gladys configuration of
  the integration (secret fields), never written to the logs nor to `/data`;
- the Hydrawise session token (access and refresh tokens, expiry, and a
  SHA-256 hash of the e-mail to tie it to the account), in
  `/data/hydrawise-session.json`, mode 600. Deleting the file only forces a new
  sign-in.

What it talks to: `app.hydrawise.com` (sign-in and GraphQL API) and
`api.hydrawise.com` (REST API, with the API key in the query string, as that
API requires), over HTTPS only. Nothing is listened to: the container opens no
port.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the Hydrawise service and the controllers the integration talks to.
