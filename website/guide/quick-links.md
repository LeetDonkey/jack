---
description: Share a jack instance with a friend through an invite link, one string that carries your address, a freshly issued API key, and any proxy headers needed to reach you.
---

# Invite links

An invite link is one string carrying everything a friend's jack needs to add
you: your peer URL, an API key issued for them, and any headers your proxy
requires. The management API calls it a quick link.

```
jack-link:v1:eyJ2IjoxLCJ0eXBlIjoicGVlciIsIm5hbWUiOiJSb3oncyBKYWNrIiwidXJsIjoi...
```

They paste it under ***Friends -> Add a friend*** in their management UI, check
the decoded fields, and click ***Add friend***.

::: danger An invite link is a credential
The link **contains a working API key in plain text**. Anyone who gets it can
search and download from your libraries until you revoke the key. Send it over
a channel you trust and never paste one into a public issue, gist, or forum.
:::

## Set up your public address

Invite links require a `jack.external` profile, editable under ***Settings ->
Sharing -> Your public address*** in the
[management UI](./management-ui.md). ***Invite a friend*** also asks for it
when it's missing.

- ***Name friends see***: the name friends see for you when they add your
  link. They can change it on their side.
- ***Address friends use***: the URL a friend's jack uses to reach you, e.g.
  `https://jack.example.com`. HTTP and HTTPS only, with no `user:password@`
  credentials embedded. ***Check*** under the field has jack fetch `/ping`
  there, the way a friend's jack would.
- ***Proxy headers (optional)***: headers a friend's jack must send to get
  through your proxy, such as Cloudflare Access service tokens. Each value is a
  [`ConfigSecret`](../reference/configuration.md#configsecret): ***Use a
  container variable or file instead*** under a value reads it from a variable
  or a file in the jack container, so the secret stays out of the config file.

Click ***Save changes***. Every link you create reuses the saved profile.
Full schema: [`jack.external`](../reference/configuration.md#jack-external).

::: tip Use HTTPS
The API key in an invite link, and in every request the peer later makes,
travels in a header. An `http://` address exposes it to anything on the path,
and jack warns at startup about peers configured over plain HTTP.
:::

::: warning Internal and external URLs are not the same
[`jack.internalUrl`](../reference/configuration.md#jack-internalurl) is the
address your own Radarr/Sonarr use to reach jack. Putting it in ***Address
friends use*** hands friends an address that only resolves on your side.
:::

## Invite a friend

***Friends -> Invite a friend*** asks for:

- ***Who is this link for?***: your friend's name. It names the key the link
  carries, and the friend's card on ***Friends***.
- ***Name your friend sees***: how you show up in your friend's list. It
  defaults to your ***Name friends see***, shown as a line such as "Alice will
  see you as Bob"; ***Change*** opens the field. Your friend can still rename
  you when they add you.
- ***Key description*** (under ***More options***): an optional note for
  yourself.

When the name matches a friend you already download from, ***This is the Alice
you download from*** (ticked) puts the new key on that friend's card.

***Create invite link*** resolves the external profile, **issues a new peer
API key**, and returns the encoded link.

The plaintext link appears **once**, in that dialog. Closing it discards the key
from the UI, the same one-time reveal as any other
[peer API key](./peering.md). Copy it with ***Copy link*** before closing; if
you lose it, ***Send a new link*** on the friend's card makes another.

::: tip One link per friend
Every link carries its own key, so revoking one friend's access leaves everyone
else connected. Never reuse one link for two people. If the name matches a
friend who already has a key, the dialog offers ***Send a new link instead***.
A new link revokes the old key if your friend's jack never used it. If it did,
or jack can't tell, the dialog asks: ***Replace*** revokes the old key, ***Keep
both*** leaves it working.
:::

## Add a friend

***Friends -> Add a friend*** takes the pasted link (***Paste the link your
friend sent***) and, after ***Continue***, shows the ***Add Alice*** form with
***Name***, ***Address*** and ***Access key*** filled in, plus any headers
under ***Advanced***. ***Add without a link*** opens the same form empty.

Nothing is saved until you click ***Add friend***, so you can rename the friend
or check where the address points first. Saving connects to their jack. If it
doesn't answer, the dialog says why. For a problem that may be temporary, such
as a timeout or a refused connection, click ***Add anyway, keep trying*** to
save the friend and let jack keep retrying in the background, or ***Back to
edit*** to check the address and key.

For a friend who already has a card because you invited them, click ***Paste
Alice's link*** on that card instead, so both directions show on one card.
When a friend sends you a new link later, click ***Paste new link*** on their
card (it shows when their jack rejected your key), or ***Change address or
key*** in the card's ***...*** menu, then ***Paste it instead***.

A link that fails any of the [format checks](#link-format) is rejected outright,
instead of half-filling the form.

## Revoking access

***Remove friend*** in the ***...*** menu on the friend's card, with ***Revoke
Alice's access (key 'Alice')*** ticked, revokes the key and the link stops
working immediately. Keys that aren't on a friend's card are under ***Settings
-> Advanced -> API keys for other tools***, where the bin icon revokes one.

Removing the `jack.external` profile (***Remove*** under ***Settings ->
Sharing -> Your public address***) only stops you from creating *new* links.
Links already out there keep working until their keys are revoked.

## Link format

The prefix `jack-link:v1:` followed by a base64url-encoded JSON object:

```json
{
  "v": 1,
  "type": "peer",
  "name": "Roz's Jack",
  "url": "https://jack.example.com",
  "apiKey": "<the freshly issued peer API key>",
  "headers": { "CF-Access-Client-Id": "..." }
}
```

There is no encryption. Anyone holding the link can read the key out of it.

Decoding is strict:

- `v` and `type` must match the values above.
- `url` must be `http`/`https`, with no embedded credentials.
- `headers` are validated against the same rules the config uses:
  - reserved names are rejected: `X-Api-Key`, `Host`, `Content-Length`,
    `Connection`, and `Transfer-Encoding`.
  - names must be valid HTTP header tokens.
  - no name may repeat.
  - values must be non-empty.
  - values may not contain line breaks.

To generate a link outside the UI, call
[`POST /quick-links`](/reference/management-api/postQuickLinks) on the
management API. A missing external profile, or one
with a secret reference that cannot be resolved, fails the request before any
key is issued, so a broken profile leaves no orphaned credential.

Two optional body fields tie the new key to a friend:

- **`peerId`**: the peer you download from that friend. The friends view then
  shows the peer and the key as one friend.
- **`replaceKeyId`**: an earlier key for the same friend. jack revokes it when
  no jack ever used it and no jack identity is bound to it. Otherwise the old
  key stays, and `replaced.keptBecause` says why:
  - `used`: a jack used it.
  - `bound`: a jack identity is bound to it.
  - `unknown`: it is older than jack's record of key use and wasn't used
    since, so a jack may still rely on it.
