-- The only approved supplier of the HL Mountain Pedal (937), Inline Accessories (1638), is deactivated.
UPDATE purchasing.vendor SET activeflag = false, modifieddate = '2025-07-15' WHERE businessentityid = 1638;
