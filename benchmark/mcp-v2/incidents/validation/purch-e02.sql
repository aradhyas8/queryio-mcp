-- anomaly: PO 2467 is complete and every received unit was rejected
SELECT (SELECT status FROM purchasing.purchaseorderheader WHERE purchaseorderid = 2467) = 4
  AND (SELECT bool_and(rejectedqty = receivedqty AND receivedqty > 0) FROM purchasing.purchaseorderdetail WHERE purchaseorderid = 2467) AS ok;
-- check: no receipt transactions exist for PO 2467
SELECT NOT EXISTS (SELECT 1 FROM production.transactionhistory WHERE transactiontype = 'P' AND referenceorderid = 2467) AS ok;
-- unique: every other fully rejected PO has status 3 (rejected); no other complete PO is fully rejected
SELECT NOT EXISTS (SELECT d.purchaseorderid FROM purchasing.purchaseorderdetail d JOIN purchasing.purchaseorderheader h USING (purchaseorderid)
  WHERE d.purchaseorderid <> 2467 AND h.status <> 3 GROUP BY 1 HAVING bool_and(d.rejectedqty = d.receivedqty AND d.receivedqty > 0)) AS ok;
