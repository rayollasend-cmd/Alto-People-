-- How the person signed in when the device credential was issued, so a
-- session the app re-opens from the Keychain keeps saying so (an SSO or
-- passkey sign-in stays one).
ALTER TABLE "NativeDevice" ADD COLUMN "authMethod" VARCHAR(20);
