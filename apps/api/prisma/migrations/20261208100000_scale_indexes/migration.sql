-- Scale pass (brief 3-6): the people directory pages 50,000 associates
-- ordered by last name, first name, id. Every other hot route already has
-- its (owner, time) index; this was the one sort left to a sequential scan.
CREATE INDEX "Associate_lastName_firstName_idx" ON "Associate"("lastName", "firstName");
