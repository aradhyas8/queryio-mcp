-- anomaly: orders 69391 and 69389 share one tracking number
SELECT (SELECT array_agg(DISTINCT salesorderid ORDER BY salesorderid) FROM sales.salesorderdetail WHERE carriertrackingnumber = '4EEB-44A4-9C') = ARRAY[69389, 69391] AS ok;
-- check: the two orders ship to different customers and addresses on the same date
SELECT (SELECT count(DISTINCT customerid) = 2 AND count(DISTINCT shiptoaddressid) = 2 AND count(DISTINCT shipdate) = 1 FROM sales.salesorderheader WHERE salesorderid IN (69389, 69391)) AS ok;
-- unique: no other tracking number spans two orders
SELECT NOT EXISTS (SELECT carriertrackingnumber FROM sales.salesorderdetail WHERE carriertrackingnumber IS NOT NULL AND carriertrackingnumber <> '4EEB-44A4-9C'
  GROUP BY 1 HAVING count(DISTINCT salesorderid) > 1) AS ok;
