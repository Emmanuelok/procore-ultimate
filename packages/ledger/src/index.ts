export { canonicalize } from "./canonical.js";
export { sha256Hex, hashPayload } from "./hash.js";
export {
  GENESIS_HASH,
  appendEntry,
  computeEntryHash,
  verifyChain,
  type ChainInput,
  type ChainedEntry,
  type VerifyResult,
} from "./chain.js";
export { merkleRoot, merkleProof, verifyMerkleProof, type MerkleProofStep } from "./merkle.js";
export {
  SEAL_ALGORITHM,
  buildSealBody,
  classifyChain,
  sealBodyBytes,
  sealBodyHash,
  signSealBody,
  verifySealChain,
  verifySealSignature,
  type ChainClassification,
  type ClassifyChainInput,
  type SealBody,
  type SealBodyInput,
  type SealChainResult,
  type SealChainVerdict,
  type SealRecord,
  type SealedChainEntry,
} from "./seal.js";
