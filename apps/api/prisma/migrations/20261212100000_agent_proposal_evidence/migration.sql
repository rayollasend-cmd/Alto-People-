-- "Agents propose, people decide": a decision showed no evidence. Each
-- proposal now carries the case the capability made for it (why this and
-- not something else, what it changes, who it touches) for the person
-- deciding. Older rows read a generic block derived from the request.
ALTER TABLE "AgentProposal" ADD COLUMN "evidence" JSONB;
