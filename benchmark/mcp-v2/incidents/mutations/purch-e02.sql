-- PO 2467 (Greenwood Athletic Company, status complete): every received unit is recorded as rejected,
-- and therefore no inventory receipt transactions exist for it.
UPDATE purchasing.purchaseorderdetail SET rejectedqty = receivedqty WHERE purchaseorderid = 2467;
DELETE FROM production.transactionhistory WHERE transactiontype = 'P' AND referenceorderid = 2467;
