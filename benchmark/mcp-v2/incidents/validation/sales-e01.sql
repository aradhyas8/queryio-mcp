-- anomaly: order 72902 ships to an address that is not one of its customer's addresses
SELECT NOT EXISTS (SELECT 1 FROM sales.salesorderheader h JOIN sales.customer c USING (customerid)
  JOIN person.businessentityaddress b ON b.businessentityid = c.personid AND b.addressid = h.shiptoaddressid
  WHERE h.salesorderid = 72902) AS ok;
-- check: the ship-to address 11431 is in France and belongs to person 2411 (customer 21113)
SELECT EXISTS (SELECT 1 FROM person.address a JOIN person.stateprovince s USING (stateprovinceid)
  JOIN person.businessentityaddress b USING (addressid) JOIN sales.customer c ON c.personid = b.businessentityid
  WHERE a.addressid = 11431 AND s.countryregioncode = 'FR' AND c.customerid = 21113) AS ok;
-- check: the customer has exactly one address (28990, Washington), still the bill-to, also used by order 72001
SELECT (SELECT array_agg(addressid) FROM person.businessentityaddress WHERE businessentityid = 19889) = ARRAY[28990]
  AND (SELECT billtoaddressid FROM sales.salesorderheader WHERE salesorderid = 72902) = 28990
  AND (SELECT shiptoaddressid FROM sales.salesorderheader WHERE salesorderid = 72001) = 28990 AS ok;
-- unique: every other order ships to one of its customer's addresses
SELECT NOT EXISTS (SELECT 1 FROM sales.salesorderheader h JOIN sales.customer c USING (customerid)
  WHERE h.salesorderid <> 72902 AND NOT EXISTS (SELECT 1 FROM person.businessentityaddress b
  WHERE b.addressid = h.shiptoaddressid AND b.businessentityid IN (c.personid, c.storeid))) AS ok;
