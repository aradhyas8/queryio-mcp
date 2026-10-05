-- Patrick Cook (83), Production Technician - WC40 under the WC40 production supervisor (/3/1/7/), is
-- re-parented in the organization hierarchy to /1/1/8/, directly under the Engineering Manager (/1/1/).
-- Department history and job title are unchanged.
UPDATE humanresources.employee SET organizationnode = '/1/1/8/', modifieddate = '2025-05-12' WHERE businessentityid = 83;
