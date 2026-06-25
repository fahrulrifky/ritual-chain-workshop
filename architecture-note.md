# Architecture Note: Commit-Reveal vs. Ritual-Native Encrypted Submissions

## 1. Two ways to hide an answer until judging

Both tracks solve the same problem — *don't let participants see each
other's answers before judging* — but they hide information in different
places and at different costs.

| | **Commit-Reveal (required track)** | **Ritual-Native Encrypted (advanced track)** |
|---|---|---|
| What's hidden during submission | The answer text (only its hash is on-chain) | The answer text (only ciphertext / a reference is on-chain) |
| Who can ever see the plaintext before judging | Nobody — it doesn't exist anywhere yet, only the committer holds it off-chain in their own head/notes | The Ritual TEE executor, briefly, inside the enclave at judging time — never any human, never the public chain |
| When the plaintext becomes public | Only when the participant *chooses* to reveal it (their own transaction) | Only after judging completes, when the system publishes the reveal bundle |
| Where judging happens | Off-chain (owner gathers revealed answers, sends one batch request to Ritual AI, posts result on-chain) | Inside a Ritual TEE, which decrypts and judges without ever exposing plaintext outside the enclave |
| Chain requirements | Works on any EVM chain — pure Solidity hashing, no special infra | Needs Ritual-specific TEE-backed execution / encrypted-input primitives |
| Trust assumption | Participants trust the contract's hash check; no need to trust any off-chain executor with secrecy | Participants trust the TEE's confidentiality guarantee (and Ritual's attestation of it) to keep ciphertext-to-plaintext decryption hidden from everyone, including the bounty owner |
| Failure mode if compromised | A participant could leak their *own* answer early voluntarily, but can't see *others'* answers early — the scheme can't be broken by an attacker without breaking keccak256 | If the TEE attestation/implementation is broken, the enclave operator (or an attacker who breaches it) could see plaintext before the public reveal |
| Implementation cost | Cheap: one extra mapping, one hash check | Higher: encryption/decryption tooling, TEE integration, key management for "encrypt to the enclave's public key" |

**Why commit-reveal is the right required track:** it gets you the core
fairness property — no one can copy an answer before judging — with
nothing but a hash function and two deadlines. It needs no trusted hardware
and works identically on any EVM chain, which is exactly the homework's
ask for the required track.

**Why Ritual-native is a meaningful upgrade, not just a fancier version of
the same idea:** commit-reveal still requires *participants themselves* to
publish their plaintext eventually (the reveal step), and the contract
itself never reads the answer text — a human/owner has to gather revealed
answers off-chain to hand to the AI. The Ritual-native flow can keep
answers encrypted *all the way through judging*, including the moment the
AI reads them, and only the *final* bundle (winner + all answers) needs to
become public. That removes a window where a slow-revealer in commit-reveal
could in theory watch other reveals land on-chain before submitting their
own reveal transaction (a real, if narrow, MEV-style risk: a participant
could front-run their own reveal after seeing someone else's reveal appear
in the same block window, though they could only react with their *own*,
already-committed answer, not write a new one).

## 2. Advanced track design: Ritual-native hidden submissions

This is presented as a design document, per the homework's note that *"the
advanced track can be a design document if full implementation is too
complex."*

### 2.1 Where do plaintext answers exist, and who can read them?

- During submission: the plaintext answer exists only on the participant's
  own device. They encrypt it client-side to the Ritual TEE executor's
  public key (or use Ritual's private-input/secret-passing flow) before
  sending anything on-chain.
- Between submission and judging: the plaintext exists nowhere except
  inside that ciphertext. No party — not the bounty owner, not other
  participants, not the contract — can decrypt it.
- At judging time: the TEE executor decrypts each submission *inside the
  enclave*. The plaintext exists transiently in enclave memory, used only
  to build the batched prompt sent to the LLM, and is never written to
  any log, storage, or output the enclave operator can read.
- After judging: plaintext becomes public only via the reveal bundle (see
  2.4), at which point it's intentionally public for everyone, including
  losers, to audit the result.

### 2.2 What's stored on-chain vs. off-chain?

- **On-chain:** bounty metadata (owner, reward, deadlines), a per-participant
  *reference* to their encrypted submission (e.g. a content hash or
  storage pointer — not the ciphertext blob itself if it's large), the
  final `revealedAnswersHash` (commit to the full bundle), and the AI's
  structured output (winner index, ranking, summary).
- **Off-chain:** the actual ciphertext blobs (e.g. on IPFS or another
  content-addressed store, referenced on-chain by hash so they can't be
  swapped after the fact), and — after judging — the plaintext reveal
  bundle itself, again referenced on-chain only by its hash
  (`revealedAnswersRef` + `revealedAnswersHash`, exactly the pattern
  suggested in the homework PDF).
- This avoids the gas cost of storing potentially long free-text answers
  directly in contract storage, while still letting anyone verify the
  off-chain bundle matches what was committed to, by re-hashing it and
  comparing to `revealedAnswersHash`.

### 2.3 How does the LLM receive all submissions together?

The TEE executor collects every participant's ciphertext reference for a
given `bountyId`, decrypts all of them inside the enclave, and assembles a
*single* batched prompt (all answers + the judging rubric) — mirroring
exactly what `judgeAll` does in the commit-reveal track, just running
inside a confidential environment instead of in the open. One LLM call per
bounty, never one per submission, satisfies the homework's explicit
constraint either way.

### 2.4 How does the final reveal happen, and how does the contract verify it?

After the TEE produces its output (matching the `Example Final Output
Shape` in the PDF: `winnerIndex`, `ranking`, `revealedAnswersRef`,
`revealedAnswersHash`, `summary`), the executor:

1. Publishes the full plaintext bundle (every participant's answer) to an
   off-chain store (IPFS/storage-ref) at `revealedAnswersRef`.
2. Computes `revealedAnswersHash = keccak256(bundle)` and submits that hash
   plus the winner index back to the contract in one `judgeAll`-equivalent
   transaction.
3. Anyone can fetch the bundle from `revealedAnswersRef`, hash it
   themselves, and confirm it matches the on-chain `revealedAnswersHash` —
   this is the verification step. The contract doesn't need to *understand*
   the bundle's contents, only commit to its hash, the same trust-minimizing
   pattern as commit-reveal's commitment check, just applied to the whole
   bundle instead of one answer at a time.
4. As in the required track, `finalizeWinner` remains a separate,
   owner-triggered, human step — the TEE's output is a recommendation with
   a verifiable hash commitment behind it, not a self-executing payout.

### 2.5 Diagram: private submission flow

```
Participant                     Ritual TEE Executor                  Contract (on-chain)
    │                                    │                                   │
    │ 1. encrypt(answer) to TEE pubkey   │                                   │
    │───────────────────────────────────▶│                                   │
    │                                    │ 2. store ciphertext off-chain     │
    │                                    │    (IPFS/storage), get a ref      │
    │ 3. submitEncryptedRef(ref) ────────┼──────────────────────────────────▶│
    │                                    │                                   │  (ref stored on-chain;
    │                                    │                                   │   plaintext nowhere yet)
    │                                    │                                   │
    │              ...submission window closes, judging triggered...        │
    │                                    │                                   │
    │                                    │◀── 4. owner calls judgeAll() ─────│
    │                                    │ 5. decrypt ALL refs inside TEE     │
    │                                    │    (plaintext only in enclave)    │
    │                                    │ 6. ONE batched LLM call            │
    │                                    │ 7. publish plaintext bundle        │
    │                                    │    off-chain → revealedAnswersRef  │
    │                                    │ 8. hash bundle → revealedAnswersHash│
    │                                    │───────────────────────────────────▶│
    │                                    │   (winnerIndex, ranking,           │
    │                                    │    revealedAnswersRef,             │
    │                                    │    revealedAnswersHash recorded)   │
    │                                    │                                   │
    │◀────────────── 9. anyone can fetch bundle + verify hash ───────────────│
    │                                    │                                   │
    │                                    │   10. owner calls finalizeWinner()│
    │                                    │       → reward paid (human step)  │
```

### 2.6 Ritual feature checklist (per homework section 5)

- **TEE-backed execution:** decryption + judging happen inside the
  enclave; the public chain never sees plaintext (2.1, 2.3).
- **Encrypted inputs/secrets:** participants encrypt to the TEE's key
  before anything touches chain state; no plaintext or credentials appear
  on-chain at any point (2.1, 2.2).
- **Batch judging:** one LLM call per bounty across all decrypted answers,
  not one per submission (2.3).
- **Human-in-the-loop finalization:** the TEE only recommends and commits
  to a verifiable hash; a human owner still calls a separate
  `finalizeWinner` to release funds (2.4, 2.6).

## 3. Reflection Question

*What should be public, what should stay hidden, and what should be
decided by AI versus by a human in a bounty system?*

Public and hidden should split along *when* information creates an unfair
advantage, not along whether information is sensitive: bounty terms,
deadlines, and the reward amount should always be public so participants
can trust the rules before they commit any effort, but the content of an
answer should stay hidden for exactly as long as it could help a rival copy
or counter it — which is precisely the submission window, not forever.
Once judging is locked in, full transparency should return: revealed
answers, the AI's ranking, and the final winner should all become public so
losers can audit that the process was fair, which is why both tracks here
end in a public reveal rather than permanent secrecy. As for AI versus
human: AI is well suited to the mechanical, scalable part of judging —
reading every submission against a rubric in one consistent pass and
producing a ranked recommendation, because doing that fairly across many
entries is exactly what it's good at and bad-faith manual reading doesn't
scale. But AI should never be the one that moves money, because its
output can be wrong, gameable by a cleverly worded answer, or simply
unverifiable to participants who can't see how it reasoned; a human owner
should always sit between the AI's recommendation and the actual payout,
able to confirm or override it, with that decision visible on-chain. That
division — AI judges, human pays — is also exactly why this contract keeps
`judgeAll` and `finalizeWinner` as two separate transactions instead of
one.
