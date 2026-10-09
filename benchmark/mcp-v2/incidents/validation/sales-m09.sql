-- anomaly: order 75031 is paid by card without an approval code and is in process
SELECT (SELECT status = 1 AND shipdate IS NULL AND creditcardid IS NOT NULL AND creditcardapprovalcode IS NULL FROM sales.salesorderheader WHERE salesorderid = 75031) AS ok;
-- unique: every other order is shipped, and every other card-paid order has an approval code
SELECT NOT EXISTS (SELECT 1 FROM sales.salesorderheader WHERE salesorderid <> 75031 AND (status <> 5 OR shipdate IS NULL OR (creditcardid IS NOT NULL AND creditcardapprovalcode IS NULL))) AS ok;
-- check: the other orders of 2025-06-27 shipped on 2025-07-04
SELECT (SELECT bool_and(shipdate = '2025-07-04') FROM sales.salesorderheader WHERE orderdate = '2025-06-27' AND salesorderid <> 75031) AS ok;
