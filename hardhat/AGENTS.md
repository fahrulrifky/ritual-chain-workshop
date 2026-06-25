# AGENTS.md

Instruksi ini dibaca oleh AI agent (Antigravity / Gemini / Claude / model lain
yang kompatibel dengan format AGENTS.md) sebelum mengerjakan apa pun di
project ini. Tujuannya supaya agent paham context tanpa harus dijelaskan
ulang setiap sesi.

## Tentang Project Ini

Ini adalah homework workshop Ritual berjudul **"Privacy-Preserving AI
Bounty Judge"**. Tujuannya: bounty owner membuat bounty, peserta submit
jawaban secara **tersembunyi** (commit-reveal), Ritual AI menilai semua
jawaban yang sudah dibuka dalam satu batch request, lalu owner (manusia)
yang memutuskan dan membayar pemenang — bukan AI yang langsung bayar.

Required track sudah diimplementasikan penuh. Advanced track (Ritual-native
TEE encrypted submissions) masih berupa design document di
`architecture-note.md`, belum diimplementasikan sebagai kode.

## Struktur File

```
contracts/AIBountyJudge.sol   -> smart contract utama (required track)
test/AIBountyJudge.test.js    -> test plan Hardhat/Mocha/Chai/ethers v6
hardhat.config.js             -> config Hardhat, sources di ./contracts, tests di ./test
package.json                  -> dependency: hardhat, hardhat-toolbox, hardhat-network-helpers
README.md                     -> penjelasan lifecycle bounty + alasan deviasi dari spek
architecture-note.md          -> perbandingan commit-reveal vs Ritual-native + desain advanced track + reflection question
```

## Status Penting: Test Belum Pernah Dijalankan

Contract dan test file ditulis bersama secara manual (tanpa akses internet
saat dibuat), lalu di-cross-check manual agar nama fungsi, custom error, dan
event di kedua file cocok satu sama lain. **Tapi belum pernah benar-benar
dieksekusi dengan `npx hardhat test`.**

**Prioritas pertama untuk agent:** jalankan `npm install` lalu
`npx hardhat test`, dan kalau ada error compile atau test gagal, perbaiki
dengan hati-hati — jangan ubah logic yang justru melemahkan aturan
commit-reveal di bawah ini hanya demi membuat test lolos.

## Aturan Kontrak yang TIDAK BOLEH Dilonggarkan

Saat memperbaiki bug atau menambah fitur, jangan sampai melanggar aturan
inti berikut (ini inti dari nilai homework):

1. `submitCommitment` hanya boleh sebelum `submissionDeadline`.
2. `revealAnswer` hanya boleh **strictly** di antara `submissionDeadline`
   dan `revealDeadline` — bukan sebelum, bukan sesudah.
3. Satu address hanya boleh submit satu commitment per bounty.
4. Reveal hanya valid kalau `keccak256(answer, salt, sender, bountyId)`
   cocok dengan commitment yang tersimpan.
5. Submission yang tidak di-reveal **tidak boleh** ikut dinilai.
6. `judgeAll` hanya bisa dipanggil owner, hanya setelah `revealDeadline`,
   hanya sekali.
7. `finalizeWinner` hanya bisa dipanggil owner, hanya setelah `judgeAll`
   selesai, hanya sekali (tidak boleh bisa dibayar dua kali).
8. **AI tidak boleh punya jalur untuk langsung mentransfer reward.**
   `judgeAll` hanya mencatat rekomendasi; `finalizeWinner` adalah transaksi
   terpisah yang harus dipanggil manual oleh owner. Jangan gabungkan dua
   fungsi ini jadi satu, dan jangan buat `finalizeWinner` otomatis terpanggil
   dari `judgeAll`.
9. Tidak boleh ada pemanggilan LLM satu-per-satu di dalam loop Solidity.
   Semua jawaban dikirim dalam satu batch (`llmInput` di `judgeAll`).

## Gaya Kode

- Pakai custom error (`error NamaError();` + `revert NamaError();`), bukan
  `require(condition, "string")` — sudah konsisten begitu di seluruh
  contract, pertahankan gaya ini.
- Solidity version: `^0.8.24`.
- Test pakai Hardhat + Mocha/Chai + ethers v6 (`ethers.parseEther`,
  `ethers.solidityPackedKeccak256`, dst — bukan syntax ethers v5) dan
  `@nomicfoundation/hardhat-network-helpers` untuk manipulasi waktu
  (`time.increaseTo`, `time.latest`).

## Kalau Diminta Lanjut ke Advanced Track

Baca dulu bagian "2. Advanced track design" di `architecture-note.md`
sebelum menulis kode apa pun. Desainnya sudah lengkap: peserta encrypt
jawaban ke TEE executor, contract hanya simpan reference (bukan ciphertext
penuh kalau besar), `judgeAll`-equivalent men-decrypt di dalam enclave lalu
publish reveal bundle + hash-nya on-chain. Jangan buat versi yang menyimpan
plaintext langsung di storage tanpa justifikasi gas cost — itu melanggar
constraint eksplisit di soal homework.

## Yang JANGAN Dilakukan

- Jangan hardcode API key Ritual atau secret apa pun di dalam contract atau
  file kode.
- Jangan ubah signature `judgeAll` jadi auto-pay (langsung transfer reward
  di fungsi yang sama dengan judging) — ini melanggar instruksi eksplisit di
  homework PDF.
- Jangan hapus atau lemahkan modifier `onlyBountyOwner` / `bountyExists`
  demi "menyederhanakan" kode.
