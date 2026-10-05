-- anomaly: PO 3784 is for a product its vendor does not supply
SELECT EXISTS (SELECT 1 FROM purchasing.purchaseorderheader h JOIN purchasing.purchaseorderdetail d USING (purchaseorderid)
  WHERE h.purchaseorderid = 3784 AND h.vendorid = 1636 AND d.productid = 941
  AND NOT EXISTS (SELECT 1 FROM purchasing.productvendor pv WHERE pv.productid = d.productid AND pv.businessentityid = h.vendorid)) AS ok;
-- check: Bicycle Specialists (1628) is the only supplier of 941 and received every other PO for it
SELECT (SELECT array_agg(businessentityid) FROM purchasing.productvendor WHERE productid = 941) = ARRAY[1628]
  AND NOT EXISTS (SELECT 1 FROM purchasing.purchaseorderdetail d JOIN purchasing.purchaseorderheader h USING (purchaseorderid)
    WHERE d.productid = 941 AND h.purchaseorderid <> 3784 AND h.vendorid <> 1628) AS ok;
-- unique: every other PO line is for a product its vendor supplies
SELECT NOT EXISTS (SELECT 1 FROM purchasing.purchaseorderheader h JOIN purchasing.purchaseorderdetail d USING (purchaseorderid)
  WHERE h.purchaseorderid <> 3784 AND NOT EXISTS (SELECT 1 FROM purchasing.productvendor pv WHERE pv.productid = d.productid AND pv.businessentityid = h.vendorid)) AS ok;
