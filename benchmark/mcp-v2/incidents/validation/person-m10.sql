-- anomaly: persons 6910 and 4128 share an email address
SELECT (SELECT array_agg(businessentityid ORDER BY businessentityid) FROM person.emailaddress WHERE emailaddress = 'brandon11@adventure-works.com') = ARRAY[4128, 6910] AS ok;
-- check: person 4128 is customer 13184, which placed order 72190 on 2025-05-04
SELECT EXISTS (SELECT 1 FROM sales.customer c JOIN sales.salesorderheader h USING (customerid) WHERE c.personid = 4128 AND c.customerid = 13184 AND h.salesorderid = 72190 AND h.orderdate = '2025-05-04') AS ok;
-- unique: no other email address is shared
SELECT NOT EXISTS (SELECT emailaddress FROM person.emailaddress WHERE emailaddress <> 'brandon11@adventure-works.com' GROUP BY 1 HAVING count(*) > 1) AS ok;
