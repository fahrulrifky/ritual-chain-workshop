const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Test plan / spec for AIBountyJudge (required commit-reveal track).
 *
 * These tests assume a standard Hardhat + ethers v6 + hardhat-network-helpers
 * setup (`npx hardhat test`). They were authored and reasoned through
 * carefully but have NOT been executed in this sandbox (no network access to
 * install Hardhat here) — treat this file as the test plan deliverable, and
 * run `npx hardhat test` locally to confirm green before submitting.
 */

describe("AIBountyJudge", function () {
  const ONE_HOUR = 60 * 60;
  const REWARD = ethers.parseEther("1.0");

  async function deployFixture() {
    const [owner, alice, bob, carol, stranger] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("AIBountyJudge");
    const contract = await Factory.deploy();
    await contract.waitForDeployment();
    return { contract, owner, alice, bob, carol, stranger };
  }

  function makeCommitment(answer, salt, sender, bountyId) {
    return ethers.solidityPackedKeccak256(
      ["string", "bytes32", "address", "uint256"],
      [answer, salt, sender, bountyId]
    );
  }

  async function createBounty(contract, owner, submissionWindow = ONE_HOUR, revealWindow = ONE_HOUR) {
    const now = await time.latest();
    const submissionDeadline = now + submissionWindow;
    const revealDeadline = submissionDeadline + revealWindow;
    const tx = await contract
      .connect(owner)
      .createBounty(submissionDeadline, revealDeadline, { value: REWARD });
    await tx.wait();
    return { bountyId: 0n, submissionDeadline, revealDeadline };
  }

  // ------------------------------------------------------------------
  // Bounty creation
  // ------------------------------------------------------------------

  describe("createBounty", function () {
    it("creates a bounty and escrows the reward", async function () {
      const { contract, owner } = await deployFixture();
      const { bountyId } = await createBounty(contract, owner);

      const b = await contract.getBounty(bountyId);
      expect(b.owner).to.equal(owner.address);
      expect(b.reward).to.equal(REWARD);
      expect(await ethers.provider.getBalance(contract.target)).to.equal(REWARD);
    });

    it("reverts if revealDeadline <= submissionDeadline", async function () {
      const { contract, owner } = await deployFixture();
      const now = await time.latest();
      await expect(
        contract.connect(owner).createBounty(now + 100, now + 100, { value: REWARD })
      ).to.be.revertedWithCustomError(contract, "InvalidDeadlines");
    });

    it("reverts with zero reward", async function () {
      const { contract, owner } = await deployFixture();
      const now = await time.latest();
      await expect(
        contract.connect(owner).createBounty(now + 100, now + 200, { value: 0 })
      ).to.be.revertedWithCustomError(contract, "InsufficientReward");
    });
  });

  // ------------------------------------------------------------------
  // submitCommitment — valid + invalid cases
  // ------------------------------------------------------------------

  describe("submitCommitment", function () {
    it("VALID: accepts a commitment during the submission phase", async function () {
      const { contract, owner, alice } = await deployFixture();
      const { bountyId } = await createBounty(contract, owner);

      const salt = ethers.randomBytes(32);
      const commitment = makeCommitment("42", salt, alice.address, bountyId);

      await expect(contract.connect(alice).submitCommitment(bountyId, commitment))
        .to.emit(contract, "CommitmentSubmitted")
        .withArgs(bountyId, alice.address, commitment);

      expect(await contract.hasCommitted(bountyId, alice.address)).to.equal(true);
    });

    it("INVALID: rejects a second commitment from the same participant", async function () {
      const { contract, owner, alice } = await deployFixture();
      const { bountyId } = await createBounty(contract, owner);
      const salt = ethers.randomBytes(32);
      const commitment = makeCommitment("42", salt, alice.address, bountyId);

      await contract.connect(alice).submitCommitment(bountyId, commitment);
      await expect(
        contract.connect(alice).submitCommitment(bountyId, commitment)
      ).to.be.revertedWithCustomError(contract, "AlreadyCommitted");
    });

    it("INVALID: rejects a commitment submitted after the submission deadline", async function () {
      const { contract, owner, alice } = await deployFixture();
      const { bountyId, submissionDeadline } = await createBounty(contract, owner);

      await time.increaseTo(submissionDeadline + 1);

      const salt = ethers.randomBytes(32);
      const commitment = makeCommitment("42", salt, alice.address, bountyId);
      await expect(
        contract.connect(alice).submitCommitment(bountyId, commitment)
      ).to.be.revertedWithCustomError(contract, "SubmissionPhaseOver");
    });

    it("INVALID: rejects a commitment for a bounty that does not exist", async function () {
      const { contract, alice } = await deployFixture();
      const salt = ethers.randomBytes(32);
      const commitment = makeCommitment("42", salt, alice.address, 999);
      await expect(
        contract.connect(alice).submitCommitment(999, commitment)
      ).to.be.revertedWithCustomError(contract, "BountyDoesNotExist");
    });
  });

  // ------------------------------------------------------------------
  // revealAnswer — valid + invalid cases (the heart of the homework)
  // ------------------------------------------------------------------

  describe("revealAnswer", function () {
    async function commitAs(contract, signer, bountyId, answer) {
      const salt = ethers.randomBytes(32);
      const commitment = makeCommitment(answer, salt, signer.address, bountyId);
      await contract.connect(signer).submitCommitment(bountyId, commitment);
      return { salt, answer };
    }

    it("VALID: reveals an answer that matches the commitment", async function () {
      const { contract, owner, alice } = await deployFixture();
      const { bountyId, submissionDeadline } = await createBounty(contract, owner);
      const { salt, answer } = await commitAs(contract, alice, bountyId, "the answer is 42");

      await time.increaseTo(submissionDeadline + 1);

      await expect(contract.connect(alice).revealAnswer(bountyId, answer, salt))
        .to.emit(contract, "AnswerRevealed")
        .withArgs(bountyId, alice.address, answer);

      const [storedAnswer, revealed] = await contract.getRevealedAnswer(bountyId, alice.address);
      expect(revealed).to.equal(true);
      expect(storedAnswer).to.equal(answer);
    });

    it("INVALID: rejects a reveal during the submission phase (too early)", async function () {
      const { contract, owner, alice } = await deployFixture();
      const { bountyId } = await createBounty(contract, owner);
      const { salt, answer } = await commitAs(contract, alice, bountyId, "early answer");

      await expect(
        contract.connect(alice).revealAnswer(bountyId, answer, salt)
      ).to.be.revertedWithCustomError(contract, "NotInRevealPhase");
    });

    it("INVALID: rejects a reveal after the reveal deadline (too late)", async function () {
      const { contract, owner, alice } = await deployFixture();
      const { bountyId, revealDeadline } = await createBounty(contract, owner);
      const { salt, answer } = await commitAs(contract, alice, bountyId, "late answer");

      await time.increaseTo(revealDeadline + 1);

      await expect(
        contract.connect(alice).revealAnswer(bountyId, answer, salt)
      ).to.be.revertedWithCustomError(contract, "NotInRevealPhase");
    });

    it("INVALID: rejects a reveal with the wrong answer (hash mismatch)", async function () {
      const { contract, owner, alice } = await deployFixture();
      const { bountyId, submissionDeadline } = await createBounty(contract, owner);
      const { salt } = await commitAs(contract, alice, bountyId, "real answer");

      await time.increaseTo(submissionDeadline + 1);

      await expect(
        contract.connect(alice).revealAnswer(bountyId, "fake answer", salt)
      ).to.be.revertedWithCustomError(contract, "CommitmentMismatch");
    });

    it("INVALID: rejects a reveal with the wrong salt", async function () {
      const { contract, owner, alice } = await deployFixture();
      const { bountyId, submissionDeadline } = await createBounty(contract, owner);
      const { answer } = await commitAs(contract, alice, bountyId, "real answer");
      const wrongSalt = ethers.randomBytes(32);

      await time.increaseTo(submissionDeadline + 1);

      await expect(
        contract.connect(alice).revealAnswer(bountyId, answer, wrongSalt)
      ).to.be.revertedWithCustomError(contract, "CommitmentMismatch");
    });

    it("INVALID: rejects a participant who never submitted a commitment", async function () {
      const { contract, owner, stranger } = await deployFixture();
      const { bountyId, submissionDeadline } = await createBounty(contract, owner);
      await time.increaseTo(submissionDeadline + 1);

      await expect(
        contract.connect(stranger).revealAnswer(bountyId, "anything", ethers.randomBytes(32))
      ).to.be.revertedWithCustomError(contract, "NoCommitmentFound");
    });

    it("INVALID: rejects copying someone else's commitment and revealing under a different sender", async function () {
      // This is the key anti-copying property: msg.sender is baked into the
      // commitment hash, so Bob cannot take Alice's exact (answer, salt) pair
      // and reveal it as his own submission unless he also committed it
      // himself under his own address beforehand (in which case it's his
      // own honestly-committed answer, not a copy of Alice's commitment).
      const { contract, owner, alice, bob } = await deployFixture();
      const { bountyId, submissionDeadline } = await createBounty(contract, owner);
      const { salt, answer } = await commitAs(contract, alice, bountyId, "alice's idea");

      // Bob never committed at all — he just tries to reveal Alice's
      // (answer, salt) under his own address.
      await time.increaseTo(submissionDeadline + 1);
      await expect(
        contract.connect(bob).revealAnswer(bountyId, answer, salt)
      ).to.be.revertedWithCustomError(contract, "NoCommitmentFound");
    });

    it("INVALID: rejects a double reveal of the same submission", async function () {
      const { contract, owner, alice } = await deployFixture();
      const { bountyId, submissionDeadline } = await createBounty(contract, owner);
      const { salt, answer } = await commitAs(contract, alice, bountyId, "answer once");

      await time.increaseTo(submissionDeadline + 1);
      await contract.connect(alice).revealAnswer(bountyId, answer, salt);

      await expect(
        contract.connect(alice).revealAnswer(bountyId, answer, salt)
      ).to.be.revertedWithCustomError(contract, "AlreadyRevealed");
    });
  });

  // ------------------------------------------------------------------
  // judgeAll
  // ------------------------------------------------------------------

  describe("judgeAll", function () {
    async function setupRevealedBounty(contract, owner, alice, bob) {
      const { bountyId, submissionDeadline, revealDeadline } = await createBounty(contract, owner);

      const saltA = ethers.randomBytes(32);
      const commitA = makeCommitment("alice answer", saltA, alice.address, bountyId);
      await contract.connect(alice).submitCommitment(bountyId, commitA);

      const saltB = ethers.randomBytes(32);
      const commitB = makeCommitment("bob answer", saltB, bob.address, bountyId);
      await contract.connect(bob).submitCommitment(bountyId, commitB);

      await time.increaseTo(submissionDeadline + 1);
      await contract.connect(alice).revealAnswer(bountyId, "alice answer", saltA);
      await contract.connect(bob).revealAnswer(bountyId, "bob answer", saltB);

      await time.increaseTo(revealDeadline + 1);
      return { bountyId };
    }

    it("VALID: owner can judge after the reveal deadline with a single batched call", async function () {
      const { contract, owner, alice, bob } = await deployFixture();
      const { bountyId } = await setupRevealedBounty(contract, owner, alice, bob);

      const llmInput = ethers.toUtf8Bytes(
        JSON.stringify({ submissions: ["alice answer", "bob answer"] })
      );

      await expect(contract.connect(owner).judgeAll(bountyId, llmInput, 0)).to.emit(
        contract,
        "Judged"
      );

      const b = await contract.getBounty(bountyId);
      expect(b.judged).to.equal(true);
    });

    it("INVALID: rejects judging before the reveal deadline", async function () {
      const { contract, owner, alice, bob } = await deployFixture();
      const { bountyId } = await createBounty(contract, owner);
      // no time advance — still in submission phase
      await expect(
        contract.connect(owner).judgeAll(bountyId, "0x", 0)
      ).to.be.revertedWithCustomError(contract, "RevealPhaseNotOver");
    });

    it("INVALID: rejects judging twice", async function () {
      const { contract, owner, alice, bob } = await deployFixture();
      const { bountyId } = await setupRevealedBounty(contract, owner, alice, bob);
      await contract.connect(owner).judgeAll(bountyId, "0x", 0);

      await expect(
        contract.connect(owner).judgeAll(bountyId, "0x", 0)
      ).to.be.revertedWithCustomError(contract, "AlreadyJudged");
    });

    it("INVALID: rejects a non-owner calling judgeAll", async function () {
      const { contract, owner, alice, bob } = await deployFixture();
      const { bountyId } = await setupRevealedBounty(contract, owner, alice, bob);

      await expect(
        contract.connect(alice).judgeAll(bountyId, "0x", 0)
      ).to.be.revertedWithCustomError(contract, "NotOwner");
    });

    it("INVALID: rejects recommending a winner index that never revealed", async function () {
      const { contract, owner, alice, bob, carol } = await deployFixture();
      const { bountyId, submissionDeadline, revealDeadline } = await createBounty(contract, owner);

      // Carol commits but never reveals.
      const saltC = ethers.randomBytes(32);
      const commitC = makeCommitment("carol answer", saltC, carol.address, bountyId);
      await contract.connect(carol).submitCommitment(bountyId, commitC);

      const saltA = ethers.randomBytes(32);
      const commitA = makeCommitment("alice answer", saltA, alice.address, bountyId);
      await contract.connect(alice).submitCommitment(bountyId, commitA);

      await time.increaseTo(submissionDeadline + 1);
      await contract.connect(alice).revealAnswer(bountyId, "alice answer", saltA);
      // Carol does NOT reveal.

      await time.increaseTo(revealDeadline + 1);

      // Carol was the 0th participant to commit, Alice the 1st (insertion order).
      await expect(
        contract.connect(owner).judgeAll(bountyId, "0x", 0) // index 0 == carol, unrevealed
      ).to.be.revertedWithCustomError(contract, "WinnerDidNotReveal");
    });
  });

  // ------------------------------------------------------------------
  // finalizeWinner
  // ------------------------------------------------------------------

  describe("finalizeWinner", function () {
    async function setupJudgedBounty(contract, owner, alice, bob) {
      const { bountyId, submissionDeadline, revealDeadline } = await createBounty(contract, owner);

      const saltA = ethers.randomBytes(32);
      const commitA = makeCommitment("alice answer", saltA, alice.address, bountyId);
      await contract.connect(alice).submitCommitment(bountyId, commitA);

      const saltB = ethers.randomBytes(32);
      const commitB = makeCommitment("bob answer", saltB, bob.address, bountyId);
      await contract.connect(bob).submitCommitment(bountyId, commitB);

      await time.increaseTo(submissionDeadline + 1);
      await contract.connect(alice).revealAnswer(bountyId, "alice answer", saltA);
      await contract.connect(bob).revealAnswer(bountyId, "bob answer", saltB);

      await time.increaseTo(revealDeadline + 1);
      await contract.connect(owner).judgeAll(bountyId, "0x", 0); // recommend alice (index 0)

      return { bountyId };
    }

    it("VALID: pays the winner exactly once and only the reward amount", async function () {
      const { contract, owner, alice, bob } = await deployFixture();
      const { bountyId } = await setupJudgedBounty(contract, owner, alice, bob);

      const before = await ethers.provider.getBalance(alice.address);
      const tx = await contract.connect(owner).finalizeWinner(bountyId, 0);
      await tx.wait();
      const after = await ethers.provider.getBalance(alice.address);

      expect(after - before).to.equal(REWARD);

      const b = await contract.getBounty(bountyId);
      expect(b.finalized).to.equal(true);
      expect(b.reward).to.equal(0n); // escrow drained, cannot be paid twice
    });

    it("INVALID: rejects finalizing before judging", async function () {
      const { contract, owner, alice } = await deployFixture();
      const { bountyId } = await createBounty(contract, owner);

      await expect(
        contract.connect(owner).finalizeWinner(bountyId, 0)
      ).to.be.revertedWithCustomError(contract, "NotYetJudged");
    });

    it("INVALID: rejects finalizing twice (no double payout)", async function () {
      const { contract, owner, alice, bob } = await deployFixture();
      const { bountyId } = await setupJudgedBounty(contract, owner, alice, bob);

      await contract.connect(owner).finalizeWinner(bountyId, 0);
      await expect(
        contract.connect(owner).finalizeWinner(bountyId, 0)
      ).to.be.revertedWithCustomError(contract, "AlreadyFinalized");
    });

    it("INVALID: rejects a non-owner finalizing", async function () {
      const { contract, owner, alice, bob } = await deployFixture();
      const { bountyId } = await setupJudgedBounty(contract, owner, alice, bob);

      await expect(
        contract.connect(bob).finalizeWinner(bountyId, 0)
      ).to.be.revertedWithCustomError(contract, "NotOwner");
    });

    it("INVALID: rejects finalizing a winner index that never revealed", async function () {
      const { contract, owner, alice, bob } = await deployFixture();
      const { bountyId } = await setupJudgedBounty(contract, owner, alice, bob);

      // index 5 is out of range entirely
      await expect(
        contract.connect(owner).finalizeWinner(bountyId, 5)
      ).to.be.revertedWithCustomError(contract, "InvalidWinnerIndex");
    });
  });
});
