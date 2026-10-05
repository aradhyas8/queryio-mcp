-- anomaly: the only vendor of product 937 is inactive
SELECT (SELECT array_agg(pv.businessentityid) FROM purchasing.productvendor pv WHERE pv.productid = 937) = ARRAY[1638]
  AND NOT (SELECT activeflag FROM purchasing.vendor WHERE businessentityid = 1638) AS ok;
-- check: the product itself is still sellable (not discontinued)
SELECT (SELECT sellenddate IS NULL AND discontinueddate IS NULL FROM production.product WHERE productid = 937) AS ok;
-- unique: all historical PO lines for product 937 went to vendor 1638
SELECT NOT EXISTS (SELECT 1 FROM purchasing.purchaseorderdetail d JOIN purchasing.purchaseorderheader h USING (purchaseorderid)
  WHERE d.productid = 937 AND h.vendorid <> 1638) AS ok;
