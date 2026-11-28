# QR Ph re-issuing checks

```bash
node tools/qr-check/check-qrph.mjs
```

No dependencies. Exits non-zero on failure.

## What this guards

A GCash or Maya personal QR is an EMVCo payload — `tag(2) + length(2, decimal)
+ value`, ending in a CRC-16/CCITT-FALSE checksum. A *personal* code is static:
it names the destination account but carries no amount. That is why a player
used to have to type the figure into their wallet by hand, and why the owner
then had to match a payment to a request by eye.

`index.html` decodes the owner's own uploaded QR once and re-issues it per
top-up request with two fields added:

| tag | meaning | value |
| --- | --- | --- |
| `01` | point of initiation | `12` (one-time) instead of `11` (static) |
| `54` | transaction amount | the figure the player typed, e.g. `500.00` |
| `62` / `05` | reference label | the pay code, e.g. `AET-X9K2` |

and then recomputes the CRC over the new payload.

**The risk this file exists for:** the merchant account field (tag `27`) is what
decides whose wallet the money lands in. If a rewrite ever corrupted it, a
player's top-up would go to a stranger and nothing else in the app would
notice — the QR would still scan, and still look right. So every case here
asserts tag `27` is byte-identical to the source, along with the merchant name,
city, category and country.

## How it is tested

- **The code under test is read out of `index.html`**, not copied. Two markers
  bracket the block and every extraction step throws rather than carry on: a
  missing marker, markers out of order, or a slice missing any of the five
  functions. An earlier tool in this repo sliced on a marker that had been
  deleted and reported success on nearly the whole file, so this one is loud.
- **The checksum is verified against a second, independent implementation.**
  The shipped one is bitwise; the one here is table-driven. A bug in one cannot
  hide behind the same bug in the other. They are compared over the fixtures
  plus 50 random strings.
- **Fixtures are synthetic.** They carry the real GCash (`GXCHPHM2XXX`) and Maya
  (`PAPHPHM1XXX`) institution codes and the real tag layout, with fake merchant
  names and numbers, so no one's details end up in git history.
- Roughly 1,270 assertions: eight amounts x three reference codes x both
  initiation flags x both fixtures, plus the refusal cases below, plus
  re-issuing an already-re-issued code four times over to prove fields do not
  pile up.

## What it must refuse

Returning `null` — and leaving the player on the plain uploaded QR — is always
correct. Guessing is not. The suite checks it refuses: a URL or wifi QR, a
tampered or truncated payload, a non-string, a length field that is not digits
or that runs past the end, a zero, negative, `NaN`, `Infinity`, absurd or
non-numeric amount, and **a code in any currency other than pesos**.

## If these fail

Something changed in the QR block in `index.html`. Do not adjust the
expectations to match the new behaviour — the assertions about tag `27` and the
CRC are the point. Fix the code, or if the block legitimately moved, update the
two markers at the top of `check-qrph.mjs`.

## What this cannot tell you

Whether GCash and Maya actually honour a re-issued personal code. That needs a
real scan on a real phone.

**GCash: confirmed on 2026-11-28.** The owner scanned a generated code with the
GCash app. It resolved to the owner's own real GCash account, and the amount
came up **pre-filled**. So a re-issued personal code is honoured, and tag 54 is
read — the two things these assertions could only check as bytes.

**Maya: still untested.** The same code path builds it and the same assertions
cover it, but no one has scanned one. Do not assume it behaves like GCash.

If a wallet ever refuses one, the owner portal has an off switch — *Build the
amount into top-up QR codes* — which puts every player straight back on the
plain uploaded QR without a code change.

## Checking the live site

```bash
node tools/qr-check/live-modal.mjs
```

Needs Playwright and no credentials. It opens the real top-up modal on the
deployed site, types into the real amount field, waits out the real debounce,
and reads whatever ended up in the QR box — then writes the rendered codes to
`modal-shots.json` so they can be decoded and checked against the source.

Override `SITE` to point at a preview deployment, `QR_TEST_OUT` for where
screenshots land, and `PLAYWRIGHT_FROM` if Playwright is not resolvable from
`/opt/node-tools/`.

Worth running after swapping a QR image in the owner portal, which is the one
change that can silently turn pre-fill off.

**Watch for stale edges.** A deploy can be live for `curl` and still be cached
for the browser a moment later; a confusing failure here is worth re-running
before being believed.
