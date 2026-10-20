-- The books' bank and card feeds connect through the provider registry
-- (Plaid), beside the other connected services (lib/providers).
ALTER TYPE "ProviderKind" ADD VALUE 'BANK_FEED';
