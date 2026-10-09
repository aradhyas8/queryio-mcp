-- anomaly: customer 12961 is assigned to Southeast though its only address is in Oregon (Northwest)
SELECT (SELECT territoryid FROM sales.customer WHERE customerid = 12961) = 5
  AND (SELECT array_agg(s.territoryid) FROM person.businessentityaddress b JOIN person.address a USING (addressid)
       JOIN person.stateprovince s USING (stateprovinceid) WHERE b.businessentityid = 8808) = ARRAY[1] AS ok;
-- check: the April order is Northwest, the June order Southeast, both to the same address
SELECT (SELECT array_agg(salesorderid || ':' || territoryid || ':' || shiptoaddressid ORDER BY orderdate) FROM sales.salesorderheader WHERE customerid = 12961)
  = ARRAY['70034:1:17861', '74780:5:17861'] AS ok;
-- unique: every other order carries the territory of its customer
SELECT NOT EXISTS (SELECT 1 FROM sales.salesorderheader h JOIN sales.customer c USING (customerid)
  WHERE h.customerid <> 12961 AND h.territoryid IS DISTINCT FROM c.territoryid) AS ok;
