-- anomaly: the receipt for PO 2829 is booked to product 511, which is not on the PO
SELECT EXISTS (SELECT 1 FROM production.transactionhistory t WHERE t.transactionid = 200016 AND t.transactiontype = 'P'
  AND t.referenceorderid = 2829 AND t.productid = 511 AND t.quantity = 550)
  AND (SELECT array_agg(productid) FROM purchasing.purchaseorderdetail WHERE purchaseorderid = 2829) = ARRAY[512] AS ok;
-- check: PO 2829 received 550 HL Road Rims and has no receipt booked to product 512
SELECT (SELECT receivedqty FROM purchasing.purchaseorderdetail WHERE purchaseorderid = 2829) = 550
  AND NOT EXISTS (SELECT 1 FROM production.transactionhistory WHERE transactiontype = 'P' AND referenceorderid = 2829 AND productid = 512) AS ok;
-- unique: every other receipt transaction is for a product on its purchase order
SELECT NOT EXISTS (SELECT 1 FROM production.transactionhistory t WHERE t.transactiontype = 'P' AND t.transactionid <> 200016
  AND NOT EXISTS (SELECT 1 FROM purchasing.purchaseorderdetail d WHERE d.purchaseorderid = t.referenceorderid AND d.productid = t.productid)) AS ok;
