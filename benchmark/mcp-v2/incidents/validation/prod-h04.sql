-- anomaly: from 2025-04-01 the BOM of 782 (size 38) uses frame 746 (size 46) instead of 747 (size 38)
SELECT EXISTS (SELECT 1 FROM production.billofmaterials WHERE productassemblyid = 782 AND componentid = 746 AND startdate = '2025-04-01' AND enddate IS NULL)
  AND EXISTS (SELECT 1 FROM production.billofmaterials WHERE productassemblyid = 782 AND componentid = 747 AND enddate = '2025-03-31') AS ok;
-- check: every work order for 782 from 2025-04-01 is fully scrapped with reason 4; at most 1 unit was scrapped in Jan-Mar 2025
SELECT (SELECT bool_and(scrappedqty = orderqty AND scrapreasonid = 4) AND count(*) = 47 FROM production.workorder WHERE productid = 782 AND startdate >= '2025-04-01')
  AND (SELECT coalesce(sum(scrappedqty), 0) FROM production.workorder WHERE productid = 782 AND startdate >= '2025-01-01' AND startdate < '2025-04-01') <= 1 AS ok;
-- check: sibling Mountain-200 assemblies show no scrap spike after April 2025
SELECT (SELECT coalesce(sum(scrappedqty), 0) FROM production.workorder WHERE productid IN (779, 780, 781, 783, 784) AND startdate >= '2025-04-01') < 10 AS ok;
-- unique: in every other assembly the frame component size matches the assembly size
SELECT NOT EXISTS (SELECT 1 FROM production.billofmaterials b JOIN production.product a ON a.productid = b.productassemblyid
  JOIN production.product c ON c.productid = b.componentid
  WHERE b.enddate IS NULL AND c.name LIKE '%Frame%' AND a.size IS NOT NULL AND c.size IS NOT NULL AND a.size <> c.size AND b.productassemblyid <> 782) AS ok;
