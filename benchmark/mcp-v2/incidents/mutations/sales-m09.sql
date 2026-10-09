-- Online order 75031 is paid by card but has no card approval code; it is stuck in process, unshipped.
UPDATE sales.salesorderheader SET status = 1, shipdate = NULL, creditcardapprovalcode = NULL WHERE salesorderid = 75031;
