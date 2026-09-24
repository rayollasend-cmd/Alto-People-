-- Out-of-office cover for a manager's team inbox: while active, the
-- covering user sees and acts on the delegating manager's direct reports
-- and is copied on that manager's notifications.
CREATE TABLE "TeamDelegation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "fromUserId" UUID NOT NULL,
    "toUserId" UUID NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "note" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamDelegation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TeamDelegation_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamDelegation_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "TeamDelegation_toUserId_endsOn_idx" ON "TeamDelegation"("toUserId", "endsOn");
CREATE INDEX "TeamDelegation_fromUserId_endsOn_idx" ON "TeamDelegation"("fromUserId", "endsOn");
