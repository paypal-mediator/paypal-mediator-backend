-- Additive: existing memberships, invitations and their default roles are unchanged.
ALTER TYPE "MerchantRole" ADD VALUE IF NOT EXISTS 'MEMBER' AFTER 'ADMIN';
