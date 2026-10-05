-- anomaly: PO 4013 duplicates PO 3277 (vendor, buyer, date, totals, lines)
SELECT (SELECT (vendorid, employeeid, orderdate, subtotal, taxamt, freight, status) FROM purchasing.purchaseorderheader WHERE purchaseorderid = 4013)
     = (SELECT (vendorid, employeeid, orderdate, subtotal, taxamt, freight, status) FROM purchasing.purchaseorderheader WHERE purchaseorderid = 3277)
  AND (SELECT array_agg((productid, orderqty, unitprice, receivedqty) ORDER BY productid) FROM purchasing.purchaseorderdetail WHERE purchaseorderid = 4013)::text
     = (SELECT array_agg((productid, orderqty, unitprice, receivedqty) ORDER BY productid) FROM purchasing.purchaseorderdetail WHERE purchaseorderid = 3277)::text AS ok;
-- check: receipts exist for all six lines of 3277 and none for 4013
SELECT (SELECT count(*) FROM production.transactionhistory WHERE transactiontype = 'P' AND referenceorderid = 3277) = 6
  AND NOT EXISTS (SELECT 1 FROM production.transactionhistory WHERE transactiontype = 'P' AND referenceorderid = 4013) AS ok;
-- unique: Norstan Bike Hut has no other duplicate purchase orders, and its other June 2025 POs all have receipts
SELECT NOT EXISTS (SELECT 1 FROM purchasing.purchaseorderheader WHERE vendorid = 1562 AND purchaseorderid NOT IN (3277, 4013)
  GROUP BY orderdate, subtotal HAVING count(*) > 1)
  AND NOT EXISTS (SELECT 1 FROM purchasing.purchaseorderheader h WHERE h.vendorid = 1562 AND h.purchaseorderid <> 4013
    AND NOT EXISTS (SELECT 1 FROM production.transactionhistory t WHERE t.transactiontype = 'P' AND t.referenceorderid = h.purchaseorderid)
    AND h.orderdate >= '2025-06-01' AND h.orderdate < '2025-07-01') AS ok;
