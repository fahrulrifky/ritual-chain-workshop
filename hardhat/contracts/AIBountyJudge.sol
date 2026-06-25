// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AIBountyJudge - Commit-Reveal Privacy-Preserving Bounty Judge
/// @notice Required track homework: answers stay hidden as commitments during the
///         submission phase, are revealed after the deadline, and only revealed
///         answers are passed to Ritual AI for batch judging. The AI's output is
///         recorded but a human (the bounty owner) must finalize the actual payout.
contract AIBountyJudge {
    // ----------------------------------------------------------------------
    // Types
    // ----------------------------------------------------------------------

    enum Phase {
        Submission, // commitments only
        Reveal, // answer + salt reveals
        Judging, // reveal deadline passed, judgeAll() can be called
        Judged, // judgeAll() has run, owner can finalize
        Finalized // winner chosen and paid
    }

    struct Bounty {
        address owner;
        uint256 reward; // wei, held in escrow by this contract
        uint64 submissionDeadline; // commitments allowed strictly before this
        uint64 revealDeadline; // reveals allowed strictly before this
        bool judged;
        bool finalized;
        uint256 winnerIndex; // index into participants[] / submissions[]
        address[] participants; // insertion order, used for indexing
    }

    struct Submission {
        bytes32 commitment; // keccak256(answer, salt, sender, bountyId)
        bool revealed;
        string answer; // empty until revealed
    }

    // ----------------------------------------------------------------------
    // Storage
    // ----------------------------------------------------------------------

    uint256 public bountyCount;

    mapping(uint256 => Bounty) private bounties;

    // bountyId => participant => submission
    mapping(uint256 => mapping(address => Submission)) private submissions;

    // bountyId => participant => has submitted a commitment at all
    mapping(uint256 => mapping(address => bool)) public hasCommitted;

    // ----------------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------------

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed owner,
        uint256 reward,
        uint64 submissionDeadline,
        uint64 revealDeadline
    );

    event CommitmentSubmitted(uint256 indexed bountyId, address indexed participant, bytes32 commitment);

    event AnswerRevealed(uint256 indexed bountyId, address indexed participant, string answer);

    event Judged(uint256 indexed bountyId, uint256 winnerIndex, bytes llmOutput);

    event WinnerFinalized(uint256 indexed bountyId, address indexed winner, uint256 reward);

    // ----------------------------------------------------------------------
    // Errors
    // ----------------------------------------------------------------------

    error NotOwner();
    error BountyDoesNotExist();
    error InvalidDeadlines();
    error SubmissionPhaseOver();
    error NotInRevealPhase();
    error RevealPhaseNotOver();
    error AlreadyCommitted();
    error NoCommitmentFound();
    error AlreadyRevealed();
    error CommitmentMismatch();
    error AlreadyJudged();
    error NotYetJudged();
    error AlreadyFinalized();
    error InvalidWinnerIndex();
    error WinnerDidNotReveal();
    error RewardTransferFailed();
    error InsufficientReward();

    // ----------------------------------------------------------------------
    // Modifiers
    // ----------------------------------------------------------------------

    modifier onlyBountyOwner(uint256 bountyId) {
        if (msg.sender != bounties[bountyId].owner) revert NotOwner();
        _;
    }

    modifier bountyExists(uint256 bountyId) {
        if (bounties[bountyId].owner == address(0)) revert BountyDoesNotExist();
        _;
    }

    // ----------------------------------------------------------------------
    // Bounty creation
    // ----------------------------------------------------------------------

    /// @notice Creates a bounty. Reward is escrowed in this contract via msg.value.
    function createBounty(uint64 submissionDeadline, uint64 revealDeadline) external payable returns (uint256 bountyId) {
        if (submissionDeadline <= block.timestamp || revealDeadline <= submissionDeadline) {
            revert InvalidDeadlines();
        }
        if (msg.value == 0) revert InsufficientReward();

        bountyId = bountyCount++;

        Bounty storage b = bounties[bountyId];
        b.owner = msg.sender;
        b.reward = msg.value;
        b.submissionDeadline = submissionDeadline;
        b.revealDeadline = revealDeadline;

        emit BountyCreated(bountyId, msg.sender, msg.value, submissionDeadline, revealDeadline);
    }

    // ----------------------------------------------------------------------
    // Required Track: Commit-Reveal
    // ----------------------------------------------------------------------

    /// @notice Submit a hidden commitment to an answer. Only the hash is stored.
    function submitCommitment(uint256 bountyId, bytes32 commitment) external bountyExists(bountyId) {
        Bounty storage b = bounties[bountyId];
        if (block.timestamp >= b.submissionDeadline) revert SubmissionPhaseOver();
        if (hasCommitted[bountyId][msg.sender]) revert AlreadyCommitted();

        hasCommitted[bountyId][msg.sender] = true;
        submissions[bountyId][msg.sender].commitment = commitment;
        b.participants.push(msg.sender);

        emit CommitmentSubmitted(bountyId, msg.sender, commitment);
    }

    /// @notice Reveal a previously committed answer. Must match the stored commitment.
    function revealAnswer(uint256 bountyId, string calldata answer, bytes32 salt) external bountyExists(bountyId) {
        Bounty storage b = bounties[bountyId];

        // Reveal is only valid strictly after submission closes and strictly
        // before the reveal deadline passes.
        if (block.timestamp < b.submissionDeadline || block.timestamp >= b.revealDeadline) {
            revert NotInRevealPhase();
        }

        Submission storage s = submissions[bountyId][msg.sender];
        if (!hasCommitted[bountyId][msg.sender]) revert NoCommitmentFound();
        if (s.revealed) revert AlreadyRevealed();

        bytes32 expected = keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId));
        if (expected != s.commitment) revert CommitmentMismatch();

        s.revealed = true;
        s.answer = answer;

        emit AnswerRevealed(bountyId, msg.sender, answer);
    }

    /// @notice After the reveal deadline, the owner triggers Ritual AI to judge
    ///         all revealed answers together in a single batched request.
    /// @param llmInput Off-chain-prepared payload (e.g. revealed answers + rubric)
    ///                 that was sent to Ritual AI. Stored/emitted for auditability;
    ///                 the actual LLM call happens off-chain (or via a Ritual
    ///                 precompile/oracle in a fuller integration).
    /// @param recommendedWinnerIndex The index into the bounty's participant list
    ///                 that the AI recommends as the winner. This is a
    ///                 RECOMMENDATION ONLY — it does not pay out by itself.
    function judgeAll(uint256 bountyId, bytes calldata llmInput, uint256 recommendedWinnerIndex)
        external
        onlyBountyOwner(bountyId)
        bountyExists(bountyId)
    {
        Bounty storage b = bounties[bountyId];
        if (block.timestamp < b.revealDeadline) revert RevealPhaseNotOver();
        if (b.judged) revert AlreadyJudged();
        if (recommendedWinnerIndex >= b.participants.length) revert InvalidWinnerIndex();

        address recommended = b.participants[recommendedWinnerIndex];
        if (!submissions[bountyId][recommended].revealed) revert WinnerDidNotReveal();

        b.judged = true;
        b.winnerIndex = recommendedWinnerIndex;

        // llmInput is accepted as a calldata audit trail of what was sent to the
        // AI (batched, not looped per-submission) and re-emitted in the event so
        // off-chain indexers / the README's test plan can verify batching.
        emit Judged(bountyId, recommendedWinnerIndex, llmInput);
    }

    /// @notice Human-in-the-loop step: the owner confirms the winner and the
    ///         contract pays out the escrowed reward. Decoupled from judgeAll so
    ///         the AI's recommendation never auto-pays.
    function finalizeWinner(uint256 bountyId, uint256 winnerIndex) external onlyBountyOwner(bountyId) bountyExists(bountyId) {
        Bounty storage b = bounties[bountyId];
        if (!b.judged) revert NotYetJudged();
        if (b.finalized) revert AlreadyFinalized();
        if (winnerIndex >= b.participants.length) revert InvalidWinnerIndex();

        address winner = b.participants[winnerIndex];
        if (!submissions[bountyId][winner].revealed) revert WinnerDidNotReveal();

        b.finalized = true;
        b.winnerIndex = winnerIndex;

        uint256 reward = b.reward;
        b.reward = 0;

        (bool ok, ) = winner.call{value: reward}("");
        if (!ok) revert RewardTransferFailed();

        emit WinnerFinalized(bountyId, winner, reward);
    }

    // ----------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------

    function getBounty(uint256 bountyId)
        external
        view
        bountyExists(bountyId)
        returns (
            address owner,
            uint256 reward,
            uint64 submissionDeadline,
            uint64 revealDeadline,
            bool judged,
            bool finalized,
            uint256 winnerIndex,
            uint256 participantCount
        )
    {
        Bounty storage b = bounties[bountyId];
        return (b.owner, b.reward, b.submissionDeadline, b.revealDeadline, b.judged, b.finalized, b.winnerIndex, b.participants.length);
    }

    function getParticipant(uint256 bountyId, uint256 index) external view bountyExists(bountyId) returns (address) {
        return bounties[bountyId].participants[index];
    }

    /// @notice Returns the commitment for a participant. Before reveal this is
    ///         the ONLY information available about their answer — the plaintext
    ///         answer is not retrievable from chain state until revealAnswer()
    ///         has been called.
    function getCommitment(uint256 bountyId, address participant) external view returns (bytes32 commitment, bool revealed) {
        Submission storage s = submissions[bountyId][participant];
        return (s.commitment, s.revealed);
    }

    /// @notice Returns the revealed answer. Reverts-to-empty-string if not yet
    ///         revealed (does not leak partial state).
    function getRevealedAnswer(uint256 bountyId, address participant) external view returns (string memory answer, bool revealed) {
        Submission storage s = submissions[bountyId][participant];
        return (s.answer, s.revealed);
    }

    function currentPhase(uint256 bountyId) external view bountyExists(bountyId) returns (Phase) {
        Bounty storage b = bounties[bountyId];
        if (b.finalized) return Phase.Finalized;
        if (b.judged) return Phase.Judged;
        if (block.timestamp >= b.revealDeadline) return Phase.Judging;
        if (block.timestamp >= b.submissionDeadline) return Phase.Reveal;
        return Phase.Submission;
    }
}
