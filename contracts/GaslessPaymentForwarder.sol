// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// Flare Contract Registry and FAsset interface
import {ContractRegistry} from "@flarenetwork/flare-periphery-contracts/flare/ContractRegistry.sol";
import {IAssetManager} from "@flarenetwork/flare-periphery-contracts/flare/IAssetManager.sol";
import {IFAsset} from "@flarenetwork/flare-periphery-contracts/flare/IFAsset.sol";

/**
 * @title GaslessPaymentForwarder
 * @notice Enables gasless FXRP transfers using EIP-712 signed meta-transactions
 * @dev Users sign payment requests off-chain, relayers submit them on-chain
 *
 * FXRP token (IFAsset) is fetched from Flare Contract Registry via:
 *   ContractRegistry.getAssetManagerFXRP() -> AssetManager.fAsset()
 *
 * Flow:
 * 1. User approves this contract to spend their FXRP (one-time)
 * 2. User signs a PaymentRequest off-chain
 * 3. Relayer submits the signed request via executePayment()
 * 4. Contract verifies signature and executes the FXRP transfer
 */
contract GaslessPaymentForwarder is EIP712, Ownable, ReentrancyGuard {
    using SafeERC20 for IFAsset;
    using ECDSA for bytes32;

    // FXRP token (IFAsset) - resolved dynamically from Flare Contract Registry

    // Nonces for replay protection
    mapping(address => uint256) public nonces;

    // Authorized relayers who can submit transactions
    mapping(address => bool) public authorizedRelayers;

    // Fee configuration (in FXRP token base units, see token decimals)
    uint256 public relayerFee;

    // EIP-712 type hash for PaymentRequest
    bytes32 public constant PAYMENT_REQUEST_TYPEHASH =
        keccak256(
            "PaymentRequest(address from,address to,uint256 amount,uint256 fee,uint256 nonce,uint256 deadline)"
        );

    // Events
    event PaymentExecuted(
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 fee,
        uint256 nonce
    );
    event RelayerAuthorized(address indexed relayer, bool authorized);
    event RelayerFeeUpdated(uint256 newFee);

    // Custom errors
    error InvalidSignature();
    error ExpiredRequest();
    error InvalidNonce();
    error UnauthorizedRelayer();
    error InsufficientAllowance();
    error ZeroAddress();

    /**
     * @notice Constructor
     * @param _relayerFee Initial relayer fee in FXRP token base units
     */
    constructor(
        uint256 _relayerFee
    ) EIP712("GaslessPaymentForwarder", "1") Ownable(msg.sender) {
        relayerFee = _relayerFee;
    }

    /**
     * @notice Get FXRP (IFAsset) from Flare Contract Registry
     * @return The FXRP token contract
     */
    function fxrp() public view returns (IFAsset) {
        IAssetManager assetManager = ContractRegistry.getAssetManagerFXRP();
        return IFAsset(address(assetManager.fAsset()));
    }

    /**
     * @notice Execute a gasless payment using a signed request
     * @param from Sender's address
     * @param to Recipient's address
     * @param amount Amount of FXRP to transfer (excluding fee)
     * @param fee Relayer fee in FXRP
     * @param deadline Timestamp after which the request expires
     * @param signature EIP-712 signature from the sender
     */
    function executePayment(
        address from,
        address to,
        uint256 amount,
        uint256 fee,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        // Validate deadline
        if (block.timestamp > deadline) revert ExpiredRequest();

        // Get current nonce
        uint256 currentNonce = nonces[from];

        // Build the struct hash for EIP-712
        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_REQUEST_TYPEHASH,
                from,
                to,
                amount,
                fee,
                currentNonce,
                deadline
            )
        );

        // Get the full EIP-712 hash
        bytes32 hash = _hashTypedDataV4(structHash);

        // Recover signer from signature
        address signer = hash.recover(signature);

        // Verify the signer is the `from` address
        if (signer != from) revert InvalidSignature();

        // Increment nonce (prevents replay)
        nonces[from] = currentNonce + 1;

        IFAsset _fxrp = fxrp();

        // Check allowance
        uint256 totalAmount = amount + fee;
        if (_fxrp.allowance(from, address(this)) < totalAmount) {
            revert InsufficientAllowance();
        }

        // Execute the transfer: from -> to
        _fxrp.safeTransferFrom(from, to, amount);

        // Transfer fee to relayer
        if (fee > 0) {
            _fxrp.safeTransferFrom(from, msg.sender, fee);
        }

        emit PaymentExecuted(from, to, amount, fee, currentNonce);
    }

    /**
     * @notice Execute multiple payments in a single transaction (batch)
     * @param requests Array of payment request data
     */
    function executeBatchPayments(
        PaymentRequest[] calldata requests
    ) external nonReentrant {
        for (uint256 i = 0; i < requests.length; i++) {
            _executePaymentInternal(requests[i]);
        }
    }

    /**
     * @notice Internal function to execute a single payment
     */
    function _executePaymentInternal(PaymentRequest calldata req) internal {
        if (block.timestamp > req.deadline) revert ExpiredRequest();

        uint256 currentNonce = nonces[req.from];

        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_REQUEST_TYPEHASH,
                req.from,
                req.to,
                req.amount,
                req.fee,
                currentNonce,
                req.deadline
            )
        );

        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = hash.recover(req.signature);

        if (signer != req.from) revert InvalidSignature();

        nonces[req.from] = currentNonce + 1;

        IFAsset _fxrp = fxrp();
        uint256 totalAmount = req.amount + req.fee;
        if (_fxrp.allowance(req.from, address(this)) < totalAmount) {
            revert InsufficientAllowance();
        }

        _fxrp.safeTransferFrom(req.from, req.to, req.amount);

        if (req.fee > 0) {
            _fxrp.safeTransferFrom(req.from, msg.sender, req.fee);
        }

        emit PaymentExecuted(req.from, req.to, req.amount, req.fee, currentNonce);
    }

    // ============ View Functions ============

    /**
     * @notice Get the current nonce for an address
     * @param account The address to query
     * @return The current nonce
     */
    function getNonce(address account) external view returns (uint256) {
        return nonces[account];
    }

    /**
     * @notice Get the EIP-712 domain separator
     * @return The domain separator hash
     */
    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /**
     * @notice Compute the hash of a payment request for signing
     * @param from Sender's address
     * @param to Recipient's address
     * @param amount Amount of FXRP to transfer
     * @param fee Relayer fee
     * @param nonce Current nonce of the sender
     * @param deadline Expiration timestamp
     * @return The EIP-712 typed data hash to sign
     */
    function getPaymentRequestHash(
        address from,
        address to,
        uint256 amount,
        uint256 fee,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_REQUEST_TYPEHASH,
                from,
                to,
                amount,
                fee,
                nonce,
                deadline
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /**
     * @notice Set relayer authorization status
     * @param relayer Address of the relayer
     * @param authorized Whether the relayer is authorized
     */
    function setRelayerAuthorization(
        address relayer,
        bool authorized
    ) external onlyOwner {
        authorizedRelayers[relayer] = authorized;
        emit RelayerAuthorized(relayer, authorized);
    }

    /**
     * @notice Update the default relayer fee
     * @param _relayerFee New fee in FXRP
     */
    function setRelayerFee(uint256 _relayerFee) external onlyOwner {
        relayerFee = _relayerFee;
        emit RelayerFeeUpdated(_relayerFee);
    }

    // ============ Structs ============

    struct PaymentRequest {
        address from;
        address to;
        uint256 amount;
        uint256 fee;
        uint256 deadline;
        bytes signature;
    }
}
